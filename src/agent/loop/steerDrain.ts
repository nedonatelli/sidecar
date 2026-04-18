import type { SteerQueue } from '../steerQueue.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import { getContentLength } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Steer-queue drain at iteration boundary (v0.65 chunk 3.2).
//
// Called from the top of each agent-loop iteration. Two responsibilities:
//
//   1. Honor the coalesce window — if the freshest pending steer arrived
//      within `coalesceWindowMs`, wait out the remaining window (capped)
//      so a rapid burst of typed submissions merges into one turn rather
//      than draining prematurely on the first one.
//
//   2. Drain the queue into a single synthetic user message and push it
//      onto `state.messages` + bump `totalChars`. Emits a compact
//      `↪ Applying N queued steer(s)` breadcrumb via onText so the user
//      sees their steer landed.
//
// The coalesce-window wait is abort-sensitive: if `signal.aborted` fires
// during the wait, we bail early without draining. The queue itself is
// left untouched so a `/resume` (chunk 3.4) can pick up where we left off.
// ---------------------------------------------------------------------------

const COALESCE_POLL_INTERVAL_MS = 100;

export interface SteerDrainOptions {
  readonly coalesceWindowMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function drainSteerQueueAtBoundary(
  state: LoopState,
  queue: SteerQueue | undefined,
  signal: AbortSignal,
  callbacks: AgentCallbacks,
  options: SteerDrainOptions,
): Promise<void> {
  if (!queue) return;
  if (queue.size() === 0) return;

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const windowMs = Math.max(0, options.coalesceWindowMs);

  // Coalesce window: if the newest pending steer arrived less than
  // windowMs ago, wait out the remainder so a rapid burst lands as
  // one coalesced turn. Poll in small slices so a user abort is
  // responsive even when the window is a couple seconds.
  if (windowMs > 0) {
    while (!signal.aborted) {
      const items = queue.peek();
      if (items.length === 0) return; // user cancelled everything while we slept
      const freshest = items.reduce((acc, i) => Math.max(acc, i.createdAt), 0);
      const elapsed = now() - freshest;
      if (elapsed >= windowMs) break;
      const remaining = windowMs - elapsed;
      await sleep(Math.min(remaining, COALESCE_POLL_INTERVAL_MS));
    }
  }

  if (signal.aborted) return;

  const drained = queue.drain();
  if (!drained) return;

  state.messages.push(drained.message);
  state.totalChars += getContentLength(drained.message.content);
  const n = drained.items.length;
  callbacks.onText(`\n↪ Applying ${n} queued steer${n === 1 ? '' : 's'}.\n`);
  state.logger?.info(`Steer queue drained: ${n} item(s) coalesced into one user turn`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
