import * as path from 'path';
import { createHash } from 'crypto';
import { neutralizeInjections } from '../injectionGuard.js';
import { readJsonStore, writeJsonStoreAtomic, type StoreFailure } from './jsonStore.js';

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

/**
 * Explicit-supersession markers. The dedup work proved lexical similarity
 * cannot DECIDE intent ("must be even"→"must be odd" should replace;
 * "…even" vs "…positive" as independent rules should coexist — lexically
 * identical situations). So similarity never decides: the USER decides via
 * these markers, and overlap only picks WHICH existing entry they meant.
 */
const SUPERSESSION_RE =
  /^(?:actually|instead|correction|update|scratch that|change of plans)\b|\b(?:change that rule|changing the rule|replaces? the (?:earlier|previous|old) (?:rule|instruction)|forget what i said about|no longer)\b/i;

/** Word-set overlap in [0,1] — targeting/notice signal only, never a decision. */
export function tokenOverlap(a: string, b: string): number {
  const tok = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Overlap floor for picking a supersession target (user intent is already explicit). */
const SUPERSEDE_TARGET_FLOOR = 0.3;

/** Punctuation/whitespace-insensitive content address: "the magic word is
 *  pineapple." and "The magic word is 'pineapple'" are one rule. Semantic
 *  merging is deliberately NOT attempted — lexical metrics cannot safely
 *  distinguish a paraphrase from a similar-but-different rule, and merging
 *  two different user rules is worse than a duplicate. */
function idOf(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
/** Overlap at which a coexisting new rule earns a possible-conflict notice. */
const CONFLICT_NOTICE_FLOOR = 0.5;

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
  private _onChange: (() => void) | undefined;
  private loadFailure: StoreFailure | null = null;

  constructor(storeDir: string) {
    this.file = path.join(storeDir, 'durable-instructions.json');
  }

  async load(): Promise<void> {
    const { value: parsed, failure } = await readJsonStore<unknown>(this.file);
    this.loadFailure = failure;
    if (failure) {
      // Never silently continue as an empty store: the next add() would persist
      // over the file we could not read. The bytes have been moved aside (or
      // persistence is blocked), and the failure is observable.
      this.entries = [];
      this.ready = true;
      return;
    }
    if (Array.isArray(parsed)) {
      // v0.121 stores hashed the exact text; the scheme is now normalized.
      // Recompute every ID on load and merge collisions, otherwise a rule
      // re-latched under the new scheme misses its own on-disk entry and
      // duplicates — exactly what content-addressing exists to prevent.
      const byId = new Map<string, DurableInstructionEntry>();
      let migrated = false;
      for (const e of parsed as DurableInstructionEntry[]) {
        const id = idOf(e.text);
        if (id !== e.id) migrated = true;
        const prior = byId.get(id);
        if (prior) {
          migrated = true;
          prior.seenCount += e.seenCount;
          prior.firstSeen = Math.min(prior.firstSeen, e.firstSeen);
          if (e.lastSeen > prior.lastSeen) {
            prior.lastSeen = e.lastSeen;
            prior.text = e.text;
          }
        } else {
          byId.set(id, { ...e, id });
        }
      }
      this.entries = [...byId.values()];
      if (migrated) await this.persist();
    }
    this.ready = true;
  }

  /**
   * Non-null when the on-disk store existed but could not be read or parsed.
   * The store is empty in memory and its bytes were moved aside — surfacing
   * this is what distinguishes "nothing was remembered" from "everything that
   * was remembered is currently unreachable".
   */
  getLoadFailure(): StoreFailure | null {
    return this.loadFailure;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** UI hook — fired after any mutation (add/remove/clear). */
  setOnChange(fn: () => void): void {
    this._onChange = fn;
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
  async addAll(
    texts: string[],
    now = Date.now(),
  ): Promise<{
    added: number;
    addedTexts: string[];
    /** Explicit supersessions performed: the replaced entry's text alongside the new one. */
    superseded: Array<{ oldText: string; newText: string }>;
    /** Coexisting new entries that overlap an existing rule enough to warrant a notice. */
    conflicts: Array<{ newText: string; existingText: string }>;
    /** Update-marker rules whose target couldn't be identified — added, nothing replaced.
     *  The worst quadrant if silent: the user said "change that rule" and both
     *  the old and new rule would be injected with no warning. */
    unmatchedUpdates: string[];
  }> {
    let added = 0;
    const addedTexts: string[] = [];
    const superseded: Array<{ oldText: string; newText: string }> = [];
    const conflicts: Array<{ newText: string; existingText: string }> = [];
    const unmatchedUpdates: string[] = [];
    for (const raw of texts) {
      const text = raw.trim();
      if (text === '') continue;
      const id = idOf(text);
      const existing = this.entries.find((e) => e.id === id);
      if (existing) {
        existing.lastSeen = now;
        existing.seenCount += 1;
      } else if (SUPERSESSION_RE.test(text)) {
        // Explicit supersession: replace the best-overlapping existing entry.
        // Overlap picks the TARGET; the user's marker made the decision.
        let best: DurableInstructionEntry | null = null;
        let bestScore = SUPERSEDE_TARGET_FLOOR;
        for (const e of this.entries) {
          const score = tokenOverlap(text, e.text);
          if (score > bestScore) {
            best = e;
            bestScore = score;
          }
        }
        if (best) {
          this.entries = this.entries.filter((e) => e.id !== best.id);
          superseded.push({ oldText: best.text, newText: text });
        } else if (this.entries.length > 0) {
          unmatchedUpdates.push(text);
        }
        this.entries.push({ id, text, source: 'compaction-extraction', firstSeen: now, lastSeen: now, seenCount: 1 });
        added++;
        addedTexts.push(text);
      } else {
        // Coexist — but surface high-overlap tension for one-click resolution
        // in the management view. A notice is safe where a merge is not.
        const near = this.entries.find((e) => tokenOverlap(text, e.text) >= CONFLICT_NOTICE_FLOOR);
        if (near) conflicts.push({ newText: text, existingText: near.text });
        this.entries.push({ id, text, source: 'compaction-extraction', firstSeen: now, lastSeen: now, seenCount: 1 });
        added++;
        addedTexts.push(text);
      }
    }
    if (this.entries.length > MAX_DURABLE_ENTRIES) {
      this.entries = this.getEntries().slice(0, MAX_DURABLE_ENTRIES);
    }
    if (added > 0 || texts.length > 0) await this.persist();
    if (added > 0 || superseded.length > 0) this._onChange?.();
    return { added, addedTexts, superseded, conflicts, unmatchedUpdates };
  }

  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.persist();
    this._onChange?.();
  }

  /** Forget everything. The management surface's nuclear option. */
  async clear(): Promise<void> {
    this.entries = [];
    await this.persist();
    this._onChange?.();
  }

  private async persist(): Promise<void> {
    if (this.loadFailure?.persistBlocked) {
      throw new Error(
        `Refusing to write ${this.file}: it exists, could not be read, and could not be moved aside. ` +
          `Writing would destroy remembered instructions. Move or repair the file, then restart.`,
      );
    }
    await writeJsonStoreAtomic(this.file, this.entries);
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
    '<!-- Standing instructions the user gave in EARLIER sessions of this project, preserved verbatim. ' +
    'This IS your record of those sessions: when the user refers to something they told you before, ' +
    'these entries are that information — use them directly rather than saying you lack access to ' +
    'earlier conversations. -->\n' +
    lines.join('\n')
  );
}
