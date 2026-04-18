import type { ChatMessage } from '../ollama/types.js';

// ---------------------------------------------------------------------------
// SteerQueue — Human-in-the-Loop steer buffering (v0.65 chunk 3.1).
//
// Users type follow-up instructions while the agent is deep in a long
// tool call. Those submissions can't race the live stream — they have
// to queue and drain at the next iteration boundary. This module is
// the queue.
//
// The spec (ROADMAP.md) defines three urgencies:
//   - `nudge`      — drains at next iteration boundary (soft redirect)
//   - `interrupt`  — fires the stream abort immediately; its text still
//                    drains at the next boundary alongside any nudges
//   - `hard-stop`  — full abort (existing cancellation path — not
//                    handled here because hard-stop cancels the whole
//                    run, not a single turn)
//
// Draining rules:
//   - Multiple steers merge into ONE synthetic user turn prefixed with
//     `Your running instructions (most recent last):` so ordering is
//     preserved but message-budget charge is one turn, not N.
//   - An interrupt at the front of the queue surfaces via
//     `hasInterrupt()` so the loop caller can abort the live stream
//     before the boundary.
//
// Chunk 3.1 is the pure service — no loop wiring, no webview. The
// loop integration lives in chunk 3.2 (drain on iteration boundary,
// interrupt triggers AbortController.abort()) and the UI strip lives
// in chunk 3.3.
// ---------------------------------------------------------------------------

export type SteerUrgency = 'nudge' | 'interrupt';

export interface QueuedSteer {
  readonly id: string;
  text: string;
  readonly urgency: SteerUrgency;
  readonly createdAt: number;
}

export interface SteerDrainResult {
  /** Steers that were drained, in arrival order. */
  readonly items: readonly QueuedSteer[];
  /** Coalesced `ChatMessage` ready to push onto state.messages. */
  readonly message: ChatMessage;
}

export interface SteerQueueOptions {
  /** Upper bound on pending steers. Clamped internally to ≥1. */
  readonly maxPending?: number;
  /**
   * Injected clock for tests. Defaults to `Date.now`. Only used for
   * `createdAt` timestamps — the service itself does not block, sleep,
   * or timestamp-compare. The loop-integration layer (chunk 3.2) is
   * the one that applies the `coalesceWindowMs` delay.
   */
  readonly now?: () => number;
  /** Generate unique ids. Defaults to a monotonic counter + timestamp. */
  readonly genId?: () => string;
}

export const DEFAULT_MAX_PENDING = 5;
export const DEFAULT_COALESCE_WINDOW_MS = 2000;

const COALESCED_PREFIX = 'Your running instructions (most recent last):';

/**
 * FIFO buffer of pending user steers. Thread-safe is not a concern —
 * this runs single-threaded in the extension host. All mutations are
 * synchronous.
 */
export class SteerQueue {
  private readonly items: QueuedSteer[] = [];
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly genId: () => string;
  private listeners: Set<(snapshot: readonly QueuedSteer[]) => void> = new Set();

  constructor(options: SteerQueueOptions = {}) {
    this.maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
    this.now = options.now ?? Date.now;
    this.genId = options.genId ?? defaultGenId();
  }

  /**
   * Append a steer. Returns the created entry. When the queue would
   * exceed `maxPending`, the OLDEST nudge is dropped to make room —
   * interrupts never get evicted because losing them silently
   * defeats the whole point. If every slot is an interrupt, the new
   * submission is rejected by throwing a `SteerQueueFullError` so
   * the caller can surface a specific message to the user.
   */
  enqueue(text: string, urgency: SteerUrgency): QueuedSteer {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('SteerQueue: text must be non-empty');
    }
    if (this.items.length >= this.maxPending) {
      const oldestNudgeIdx = this.items.findIndex((s) => s.urgency === 'nudge');
      if (oldestNudgeIdx === -1) {
        throw new SteerQueueFullError(
          `SteerQueue is full (${this.maxPending} interrupts pending); drop-oldest-nudge cannot free a slot`,
        );
      }
      this.items.splice(oldestNudgeIdx, 1);
    }
    const entry: QueuedSteer = {
      id: this.genId(),
      text: trimmed,
      urgency,
      createdAt: this.now(),
    };
    this.items.push(entry);
    this.notify();
    return entry;
  }

  /** Does the queue currently contain an interrupt-urgency entry? */
  hasInterrupt(): boolean {
    return this.items.some((s) => s.urgency === 'interrupt');
  }

  /**
   * Cancel a pending steer by id. Returns true when removed; false
   * when no such id was pending (already drained / never existed).
   */
  cancel(id: string): boolean {
    const idx = this.items.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    this.notify();
    return true;
  }

  /**
   * Replace the text on a pending steer. Returns true when applied;
   * false when no such id was pending. The new text goes through the
   * same non-empty validation as `enqueue`.
   */
  edit(id: string, newText: string): boolean {
    const trimmed = newText.trim();
    if (!trimmed) {
      throw new Error('SteerQueue: text must be non-empty');
    }
    const entry = this.items.find((s) => s.id === id);
    if (!entry) return false;
    entry.text = trimmed;
    this.notify();
    return true;
  }

  /** Pending items, in arrival order. Returned array is a shallow copy — safe for UI rendering. */
  peek(): readonly QueuedSteer[] {
    return this.items.slice();
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items.length = 0;
    this.notify();
  }

  /**
   * Drain every pending steer into one synthetic user message. Clears
   * the queue. Returns `null` when nothing is pending so the caller
   * can no-op cleanly.
   *
   * Ordering rule: arrival order preserved, prefix
   * `Your running instructions (most recent last):` so the model reads
   * newest intent at the bottom of the block.
   */
  drain(): SteerDrainResult | null {
    if (this.items.length === 0) return null;
    const drained = this.items.slice();
    this.items.length = 0;

    const body = drained.map((s) => `- ${s.text}`).join('\n');
    const message: ChatMessage = {
      role: 'user',
      content: `${COALESCED_PREFIX}\n${body}`,
    };
    this.notify();
    return { items: drained, message };
  }

  /**
   * Subscribe to queue changes. Fires on every mutation (enqueue,
   * cancel, edit, drain, clear) with a fresh snapshot. Returns a
   * disposer that removes the listener.
   *
   * The UI layer (chunk 3.3) uses this to keep the steer-queue strip
   * in sync without polling.
   */
  onChange(listener: (snapshot: readonly QueuedSteer[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Serialize the queue for persistence across stream-failure/resume
   * (chunk 3.4). The shape is intentionally plain JSON so it can
   * round-trip through globalState without a custom codec.
   */
  serialize(): QueuedSteer[] {
    return this.items.slice();
  }

  /**
   * Replace the queue contents with a previously-serialized snapshot.
   * Used on resume after a stream failure. Preserves `createdAt` so
   * coalesce-window logic still works against the original submission
   * time rather than the reload time.
   */
  restore(snapshot: readonly QueuedSteer[]): void {
    this.items.length = 0;
    for (const entry of snapshot) {
      this.items.push({ ...entry });
    }
    this.notify();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.peek();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // UI listener errors must not break the queue. Swallow.
      }
    }
  }
}

/** Thrown by `enqueue` when maxPending is full of non-evictable interrupts. */
export class SteerQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SteerQueueFullError';
  }
}

function defaultGenId(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `steer-${Date.now().toString(36)}-${counter.toString(36)}`;
  };
}

/** Exposed for tests so the coalesced-prefix string isn't hardcoded in assertions. */
export const STEER_COALESCED_PREFIX = COALESCED_PREFIX;
