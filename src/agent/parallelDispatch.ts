// ---------------------------------------------------------------------------
// Parallel dispatch primitive (v0.67 chunk 2).
//
// Bounded parallel execution — the shared substrate for every subsystem
// that runs N tasks with a concurrency cap: multi-file edit streams,
// facet dispatch, and the upcoming Fork & Parallel Solve (chunk 4+).
// Before this module, the pattern lived duplicated in two places:
//
//   - `src/agent/loop/multiFileEdit.ts` → `runWithCap(tasks, cap)`
//   - `src/agent/facets/facetDispatcher.ts` → `runLayerWithCap(items, worker, cap)`
//
// Both implemented the same pool-of-N worker loop with slightly
// different signatures (one returns `PromiseSettledResult[]`, the
// other takes a worker callback and returns void). Fork will need a
// third copy unless we consolidate — so this module canonicalizes the
// pattern + adds `AbortSignal` support that both existing callers
// wanted but neither plumbed through.
//
// The module is deliberately tiny and VS Code-free so it's trivially
// testable and reusable anywhere in the agent. The abort contract is
// cooperative: workers check the signal before claiming the next
// task index, in-flight tasks complete as they would otherwise. Tasks
// that never started surface as a synthetic `{ status: 'rejected',
// reason: Error('aborted before start') }` so callers don't need a
// separate undefined-check path.
// ---------------------------------------------------------------------------

export interface RunWithCapOptions {
  /**
   * Max tasks in flight at once. Clamped to [1, tasks.length]. Omit
   * or pass any value ≥ tasks.length to run everything in parallel.
   */
  readonly cap?: number;
  /**
   * Cooperative abort signal. When fired, workers stop claiming new
   * task indices and any remaining task slots surface as
   * `{ status: 'rejected', reason: Error('aborted before start') }`.
   * In-flight tasks complete normally — cancellation inside a task
   * is the task's own responsibility (the task's own loop should be
   * signal-aware if that matters).
   */
  readonly signal?: AbortSignal;
}

/**
 * Error thrown (well — carried as `reason`) for result slots that
 * were never started because the signal fired first. Typed so
 * callers can distinguish "my task failed" from "my task was
 * cancelled before it ran" via `err.name === 'AbortedBeforeStart'`.
 */
export class AbortedBeforeStartError extends Error {
  override readonly name = 'AbortedBeforeStart';
  constructor(message = 'aborted before start') {
    super(message);
  }
}

/**
 * Run an array of task factories with bounded parallelism. Returns
 * one `PromiseSettledResult` per input task, preserving input order.
 * Never throws — every outcome is either `fulfilled` or `rejected`.
 */
export async function runWithCap<T>(
  tasks: readonly (() => Promise<T>)[],
  options: RunWithCapOptions = {},
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  if (tasks.length === 0) return results;

  const cap = Math.min(Math.max(1, options.cap ?? tasks.length), tasks.length);
  const signal = options.signal;

  // If the signal was already aborted before we started, every slot
  // is synthesized as "aborted before start" — no workers spawn.
  if (signal?.aborted) {
    for (let i = 0; i < tasks.length; i++) {
      results[i] = { status: 'rejected', reason: new AbortedBeforeStartError() };
    }
    return results;
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= tasks.length) return;
      try {
        const value = await tasks[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));

  // Fill in any slots that workers never claimed (abort mid-run).
  for (let i = 0; i < results.length; i++) {
    if (results[i] === undefined) {
      results[i] = { status: 'rejected', reason: new AbortedBeforeStartError() };
    }
  }

  return results;
}

/**
 * Worker-pattern variant: call `work(item)` for each item with
 * bounded parallelism. Useful when callers already handle their own
 * errors inside the worker (writing into a Map, logging to a
 * callback, etc.) and don't want the `PromiseSettledResult[]` shape.
 *
 * Errors thrown by `work` are swallowed — the pool keeps running
 * remaining items. This matches the pre-extraction Facets contract,
 * where `dispatchFacet` absorbs exceptions into a result object
 * before returning.
 */
export async function runForEachWithCap<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  options: RunWithCapOptions = {},
): Promise<void> {
  if (items.length === 0) return;
  const cap = Math.min(Math.max(1, options.cap ?? items.length), items.length);
  const signal = options.signal;
  if (signal?.aborted) return;

  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        await work(items[i]);
      } catch {
        // Swallowed — callers handle their own errors in the worker
        // body. See module header for rationale.
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
}
