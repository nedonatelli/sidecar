import type { ChatMessage } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import { runAgentLoopInSandbox, type SandboxResult } from '../shadow/sandbox.js';
import { runWithCap, AbortedBeforeStartError } from '../parallelDispatch.js';

// ---------------------------------------------------------------------------
// Fork dispatcher — primitive for Fork & Parallel Solve (v0.67 chunk 3).
//
// Runs the agent loop N times in parallel against the same user task,
// each inside its own Shadow Workspace off the current HEAD. Every
// fork gets natural variance — same prompt, same model, same tools,
// but the agent's choice of which file to read first, how to refactor,
// etc. diverges per run. The review UI (chunk 5) then presents each
// fork's diff side-by-side so the user can compare + pick the best.
//
// This module owns:
//   - `dispatchForks` — spawns N shadows, runs N agent loops via
//     `runWithCap` with a concurrency cap, collects typed results in
//     input order.
//
// It does NOT own:
//   - Metrics collection (chunk 4 — per-fork LOC / tests / guards).
//   - Review UI or hunk-picking (chunk 5).
//   - `/fork` slash command or command-palette wiring (chunk 6).
//
// Shares the shadow+defer pattern with Facets (v0.66 chunk 3.6): every
// fork runs with `forceShadow: true, deferPrompt: true` so the user's
// main tree is untouched during the run and no mid-run quickpicks fire.
// Diffs land in `SandboxResult.pendingDiff` for the review UI to apply
// later via `git apply`.
// ---------------------------------------------------------------------------

export interface ForkResult {
  /**
   * Stable fork identifier, format `fork-<N>` where N is the 0-based
   * index in the batch. Threaded through callback tags so a webview
   * can route streaming events to the right fork's column.
   */
  readonly forkId: string;
  /** 0-based position in the dispatched batch. */
  readonly index: number;
  /**
   * Human-readable label for the review UI — defaults to
   * `Fork <index+1>` when the caller omits labels. Chunks 4+ will
   * let callers pass variant-specific labels like "Fork A (Opus)"
   * for model-variant forks.
   */
  readonly label: string;
  /** `true` iff the agent loop completed without throwing. */
  readonly success: boolean;
  /** Error message when `success === false`. */
  readonly errorMessage?: string;
  /** Assembled text output from this fork's agent loop. */
  readonly output: string;
  /** Total chars consumed by this fork's loop (for spend accounting). */
  readonly charsConsumed: number;
  /**
   * Shadow workspace outcome. Carries `pendingDiff` when the run
   * produced changes — the review UI (chunk 5) reads it to render
   * side-by-side diffs and dispatches `git apply` on accept.
   */
  readonly sandbox: SandboxResult;
  /** Wall-clock duration of this fork's run in ms. */
  readonly durationMs: number;
}

export interface ForkDispatchBatchResult {
  /**
   * One result per dispatched fork, ordered by `index`. A fork that
   * aborted before starting (signal fired during an earlier fork's
   * run with a restrictive concurrency cap) surfaces as
   * `success: false, errorMessage: 'aborted-before-start'` rather
   * than being omitted — this keeps callers' index alignment stable
   * when they walk the returned array.
   */
  readonly results: readonly ForkResult[];
  /** Total wall-clock from dispatch entry to all-forks-settled. */
  readonly elapsedMs: number;
}

export interface ForkDispatchOptions {
  /** The shared task every fork receives. */
  readonly task: string;
  /**
   * Optional context block injected alongside the task, mirroring the
   * Facets dispatcher pattern. Useful when the caller already has
   * accumulated state (e.g. failing test output) the fork should see.
   */
  readonly context?: string;
  /**
   * Number of parallel forks to dispatch. The caller should clamp to
   * a sane range (the dispatcher itself accepts whatever's passed
   * but a value < 2 degenerates to "N=1 with shadow", which is a
   * silly dispatcher call — callers should route to the regular loop).
   */
  readonly numForks: number;
  /**
   * Max forks in flight at once. Clamped to [1, numForks] inside.
   * Typical production value is 3–4 to match the user's local
   * concurrency tolerance + shadow-workspace disk-churn budget.
   */
  readonly maxConcurrent: number;
  readonly signal: AbortSignal;
  /**
   * Forwarded verbatim to `runAgentLoopInSandbox`. Every fork shares
   * the same options; chunk 4 will layer per-fork variant overrides
   * (different temperature / model / prompt tweak per fork) on top.
   */
  readonly agentOptions?: AgentOptions;
  /**
   * Optional per-fork labels. Length must match `numForks` if
   * provided — a mismatch falls back to the default "Fork N" naming
   * for every fork rather than silently aligning.
   */
  readonly labels?: readonly string[];
}

/**
 * Dispatch N forks in parallel. Each fork runs the full agent loop
 * inside its own Shadow Workspace off `HEAD` (`forceShadow: true`)
 * with per-run prompts deferred (`deferPrompt: true`) so the batch
 * completes without firing N overlapping quickpicks mid-run.
 *
 * Returns results in input order (by index). Individual fork failures
 * are captured as `success: false` entries; the batch always resolves
 * rather than rejecting, so callers get full telemetry on partial
 * success.
 */
export async function dispatchForks(
  client: SideCarClient,
  parentCallbacks: AgentCallbacks,
  options: ForkDispatchOptions,
): Promise<ForkDispatchBatchResult> {
  const startMs = Date.now();
  const numForks = Math.max(1, options.numForks);
  const cap = Math.min(Math.max(1, options.maxConcurrent), numForks);

  // Resolve per-fork labels up-front so the telemetry surface is
  // stable from the moment dispatch starts — useful for UIs that
  // render N columns before any fork produces output.
  const labels = resolveLabels(numForks, options.labels);

  parentCallbacks.onText(
    `\n[fork dispatching ${numForks} parallel approach${numForks === 1 ? '' : 'es'}: ${options.task.slice(0, 80)}]\n`,
  );

  const tasks = Array.from({ length: numForks }, (_, i) => {
    return () => runOneFork(client, parentCallbacks, options, i, labels[i]);
  });

  const settled = await runWithCap(tasks, { cap, signal: options.signal });

  const results: ForkResult[] = settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    const reason = outcome.reason;
    const abortedBeforeStart = reason instanceof AbortedBeforeStartError;
    const errorMessage = abortedBeforeStart
      ? 'aborted-before-start'
      : reason instanceof Error
        ? reason.message
        : String(reason);
    return {
      forkId: `fork-${i}`,
      index: i,
      label: labels[i],
      success: false,
      errorMessage,
      output: '',
      charsConsumed: 0,
      sandbox: { mode: 'direct', applied: false, reason: 'apply-failed' },
      durationMs: 0,
    };
  });

  const ok = results.filter((r) => r.success).length;
  parentCallbacks.onText(`\n[fork batch complete: ${ok}/${numForks} succeeded in ${Date.now() - startMs}ms]\n`);

  return { results, elapsedMs: Date.now() - startMs };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runOneFork(
  client: SideCarClient,
  parentCallbacks: AgentCallbacks,
  options: ForkDispatchOptions,
  index: number,
  label: string,
): Promise<ForkResult> {
  const forkId = `fork-${index}`;
  const startMs = Date.now();

  // Per-fork callbacks tag tool events with the fork's ID so a
  // multi-fork review UI can route streaming output to the right
  // column without losing the original tool name.
  let output = '';
  let charsConsumed = 0;
  const forkCallbacks: AgentCallbacks = {
    onText: (text) => {
      output += text;
      parentCallbacks.onText(text);
    },
    onCharsConsumed: (chars) => {
      charsConsumed += chars;
      parentCallbacks.onCharsConsumed?.(chars);
    },
    onThinking: (thinking) => {
      parentCallbacks.onThinking?.(thinking);
    },
    onToolCall: (name, input, toolId) => {
      parentCallbacks.onToolCall(`${forkId}:${name}`, input, toolId);
    },
    onToolResult: (name, result, isError, toolId) => {
      parentCallbacks.onToolResult(`${forkId}:${name}`, result, isError, toolId);
    },
    onDone: () => {
      // Intentionally empty — the orchestrator's batch-completion
      // message handles the "all forks done" reporting.
    },
  };

  const initialMessages: ChatMessage[] = [
    {
      role: 'user',
      content: options.context ? `Context:\n${options.context}\n\nTask: ${options.task}` : `Task: ${options.task}`,
    },
  ];

  parentCallbacks.onText(`\n[${label} starting]\n`);

  try {
    const sandbox = await runAgentLoopInSandbox(
      client,
      initialMessages,
      forkCallbacks,
      options.signal,
      {
        ...options.agentOptions,
        // Autonomous — fork is a non-interactive parallel solve.
        // Approval still fires for destructive tools that opt in.
        approvalMode: 'autonomous',
      },
      // Force shadow + defer the per-run prompt (v0.66 chunk 3.6):
      // the aggregated Fork review UI (chunk 5) applies diffs after
      // all forks settle, so no mid-run quickpicks fire.
      { forceShadow: true, deferPrompt: true },
    );
    parentCallbacks.onText(`\n[${label} completed]\n`);
    return {
      forkId,
      index,
      label,
      success: true,
      output: output.trim() || '(fork produced no output)',
      charsConsumed,
      sandbox,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    parentCallbacks.onText(`\n[${label} failed: ${errorMessage}]\n`);
    return {
      forkId,
      index,
      label,
      success: false,
      errorMessage,
      output: output.trim(),
      charsConsumed,
      // A failed run may never have created a shadow; report 'direct'
      // so callers don't try to read a non-existent shadow diff.
      sandbox: { mode: 'direct', applied: false, reason: 'apply-failed' },
      durationMs: Date.now() - startMs,
    };
  }
}

function resolveLabels(numForks: number, supplied?: readonly string[]): string[] {
  if (supplied && supplied.length === numForks) return [...supplied];
  // Mismatched length falls back to defaults rather than silently
  // aligning — caller bug is worth surfacing via consistent output.
  return Array.from({ length: numForks }, (_, i) => `Fork ${i + 1}`);
}
