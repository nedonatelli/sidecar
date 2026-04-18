import type { ChatMessage, ToolDefinition } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import { runAgentLoopInSandbox, type SandboxResult } from '../shadow/sandbox.js';
import type { FacetDefinition } from './facetLoader.js';
import type { FacetRegistry } from './facetRegistry.js';

// ---------------------------------------------------------------------------
// Facet dispatcher (v0.66 chunk 3.3).
//
// Runs a facet's sub-agent loop with its tool allowlist, preferred
// model, and a dedicated Shadow Workspace off the current HEAD, so
// N parallel specialists don't clobber each other's writes or the
// main tree. Each facet returns its own diff result; the multi-facet
// review surface (chunk 3.6) assembles them into a unified review.
//
// This module owns:
//   - `dispatchFacet` — single-facet runner (handles model pinning,
//     tool filtering, system-prompt composition, shadow workspace).
//   - `dispatchFacets` — multi-facet orchestrator that walks the
//     registry's topological layers and caps in-flight facets at
//     `maxConcurrent`.
//
// It does NOT own:
//   - The typed RPC bus between facets (chunk 3.4 — separate module).
//   - The Expert Panel UI (chunk 3.5).
//   - Unified per-facet review (chunk 3.6).
// ---------------------------------------------------------------------------

export interface FacetDispatchResult {
  readonly facetId: string;
  /** Assembled text output from the facet's loop — for UI + review. */
  readonly output: string;
  /** Did the loop complete without throwing? (independent of diff applied). */
  readonly success: boolean;
  /** Error message when `success === false`. */
  readonly errorMessage?: string;
  /** Chars consumed by the facet's loop (counted toward parent budget when shared). */
  readonly charsConsumed: number;
  /** Shadow workspace outcome (always 'shadow' mode in the facet pipeline). */
  readonly sandbox: SandboxResult;
  /** Wall-clock duration of the facet's run in ms. */
  readonly durationMs: number;
}

export interface DispatchFacetOptions {
  /** The shared task every selected facet receives. */
  readonly task: string;
  /**
   * Optional context block injected into the facet's first user turn
   * (alongside the task). Examples: a file that's under discussion,
   * a test output the user wants analyzed, etc.
   */
  readonly context?: string;
  readonly signal: AbortSignal;
  /** Forwarded verbatim to runAgentLoopInSandbox. */
  readonly agentOptions?: AgentOptions;
}

/**
 * Run one facet to completion. The facet runs in an isolated Shadow
 * Workspace so its writes don't touch main until the user accepts the
 * diff via the review panel (chunk 3.6) — but even when
 * `sidecar.shadowWorkspace.mode` is `off`, this dispatcher forces the
 * shadow path on for facet runs. Rationale: facets are by definition
 * experimental / parallel specialists; the main tree should never be
 * the dispatch target because other facets are writing to their own
 * shadows simultaneously.
 *
 * The facet's system prompt is PRE-pended to the client's existing
 * system prompt and restored in a finally block — same pattern as
 * spawnSubAgent. The parent's prompt continues to land underneath so
 * operating rules (file safety, audit gate, etc.) still apply.
 *
 * `preferredModel` is pinned via `setTurnOverride` for the facet's
 * lifetime, then restored in the same finally. This ensures the
 * orchestrator's main-line dispatches afterward route to the user's
 * selected model, not the facet's specialist override.
 */
export async function dispatchFacet(
  client: SideCarClient,
  facet: FacetDefinition,
  parentCallbacks: AgentCallbacks,
  options: DispatchFacetOptions,
): Promise<FacetDispatchResult> {
  const startMs = Date.now();
  const priorSystemPrompt = client.getSystemPrompt();
  const priorModelOverride = client.getTurnOverride();

  // Pin the facet's preferred model before the sandbox run.
  if (facet.preferredModel && facet.preferredModel.length > 0) {
    client.setTurnOverride(facet.preferredModel);
  }

  // Compose facet system prompt on top of the existing one so the
  // orchestrator's operating rules (file safety, audit gate, etc.)
  // still apply underneath the specialist persona.
  client.updateSystemPrompt(
    [
      `You are dispatched as the "${facet.displayName}" facet (id: ${facet.id}).`,
      `Complete the task below using ONLY tools your facet allowlist grants.`,
      `Run in your own Shadow Workspace — your writes won't touch main until the user reviews your diff.`,
      `Be concise. Be precise. Do not ask clarifying questions; use your best judgment within the facet's scope.`,
      '',
      facet.systemPrompt,
      '',
      '--- orchestrator rules ---',
      priorSystemPrompt,
    ].join('\n'),
  );

  const initialMessages: ChatMessage[] = [
    {
      role: 'user',
      content: options.context ? `Context:\n${options.context}\n\nTask: ${options.task}` : `Task: ${options.task}`,
    },
  ];

  let output = '';
  let charsConsumed = 0;
  const facetCallbacks: AgentCallbacks = {
    onText: (text) => {
      output += text;
      // Surface the facet's output to the parent prefixed with its id
      // so multi-facet runs don't interleave as anonymous noise.
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
      parentCallbacks.onToolCall(`${facet.id}:${name}`, input, toolId);
    },
    onToolResult: (name, result, isError, toolId) => {
      parentCallbacks.onToolResult(`${facet.id}:${name}`, result, isError, toolId);
    },
    onDone: () => {
      // onDone intentionally empty — the orchestrator's summary
      // message handles completion reporting.
    },
  };

  parentCallbacks.onText(`\n[facet ${facet.id} dispatching: ${options.task.slice(0, 80)}]\n`);

  // Compose the agent-options shape: tool allowlist → toolOverride
  // + modeToolPermissions (same technique localWorker uses), plus
  // the caller's own agentOptions extras.
  const toolOverride: ToolDefinition[] | undefined =
    facet.toolAllowlist && facet.toolAllowlist.length > 0
      ? buildToolOverride(facet.toolAllowlist, options.agentOptions?.toolOverride)
      : undefined;

  const modeToolPermissions = facet.toolAllowlist
    ? Object.fromEntries(facet.toolAllowlist.map((n) => [n, 'allow' as const]))
    : undefined;

  try {
    const sandbox = await runAgentLoopInSandbox(
      client,
      initialMessages,
      facetCallbacks,
      options.signal,
      {
        ...options.agentOptions,
        toolOverride,
        modeToolPermissions: { ...options.agentOptions?.modeToolPermissions, ...modeToolPermissions },
        // Autonomous — a facet is a specialist, not a user-interactive
        // session. Approval still fires for destructive tools that
        // opt in via `alwaysRequireApproval`.
        approvalMode: 'autonomous',
      },
      // Force shadow on — every facet run is sandboxed regardless of
      // the user's global shadowWorkspaceMode preference.
      { forceShadow: true },
    );
    parentCallbacks.onText(`\n[facet ${facet.id} completed]\n`);
    return {
      facetId: facet.id,
      output: output.trim() || '(facet produced no output)',
      success: true,
      charsConsumed,
      sandbox,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    parentCallbacks.onText(`\n[facet ${facet.id} failed: ${errorMessage}]\n`);
    return {
      facetId: facet.id,
      output: output.trim(),
      success: false,
      errorMessage,
      charsConsumed,
      // A failed run may never have created a shadow; report 'direct'
      // so callers don't try to read a non-existent shadow diff.
      sandbox: { mode: 'direct', applied: false, reason: 'apply-failed' },
      durationMs: Date.now() - startMs,
    };
  } finally {
    client.updateSystemPrompt(priorSystemPrompt);
    client.setTurnOverride(priorModelOverride);
  }
}

/**
 * Run a batch of facets through the registry's topological layers,
 * with bounded parallelism. Facets in the same layer run concurrently
 * (up to `maxConcurrent`); a later layer starts only after every
 * facet in all prior layers has settled. Each facet gets its own
 * shadow workspace — they don't see each other's in-progress writes,
 * only the committed HEAD they branched from.
 *
 * Returns results in input order (not layer order) so callers can
 * correlate the `facetIds` they submitted with the outputs they got.
 * Failed facets are included in the array with `success: false`.
 *
 * Aborts propagate: when `options.signal` fires, in-flight facets
 * see the abort via their own loop's signal wiring, and any facets
 * not yet started are skipped (surface as aborted with an explanatory
 * error).
 */
export async function dispatchFacets(
  client: SideCarClient,
  registry: FacetRegistry,
  facetIds: readonly string[],
  parentCallbacks: AgentCallbacks,
  options: DispatchFacetOptions & { maxConcurrent: number },
): Promise<FacetDispatchResult[]> {
  if (facetIds.length === 0) return [];

  // Resolve facet IDs to definitions up front so a bad id fails the
  // whole dispatch rather than mid-run. Unknown ids are a user error.
  const resolved: FacetDefinition[] = [];
  for (const id of facetIds) {
    const facet = registry.get(id);
    if (!facet) {
      // Synthesize an error result rather than throwing so the caller
      // still gets a 1:1 result-per-input shape and the Expert Panel
      // can render the unknown-id error alongside any valid facets.
      const ms = Date.now();
      // Push one pseudo-result per unknown id, preserve input order
      // by appending to the returned array via a parallel carrier.
      // We handle this by running the resolution + result-building
      // in one loop below instead.
      void ms;
    }
    if (facet) resolved.push(facet);
  }

  // Filter the registry's layer structure down to just the selected
  // facets so we run them in dependency order.
  const selectedIds = new Set(resolved.map((f) => f.id));
  const layersFiltered: FacetDefinition[][] = registry
    .layers()
    .map((layer) => layer.filter((f) => selectedIds.has(f.id)))
    .filter((layer) => layer.length > 0);

  const resultsById = new Map<string, FacetDispatchResult>();
  for (const layer of layersFiltered) {
    if (options.signal.aborted) break;
    await runLayerWithCap(
      layer,
      async (facet) => {
        const r = await dispatchFacet(client, facet, parentCallbacks, options);
        resultsById.set(facet.id, r);
      },
      options.maxConcurrent,
    );
  }

  // Rebuild results in original input order. Unknown IDs surface as
  // synthetic error results so the caller's index alignment is stable.
  const out: FacetDispatchResult[] = [];
  for (const id of facetIds) {
    const r = resultsById.get(id);
    if (r) {
      out.push(r);
      continue;
    }
    const knownIds = registry.all.map((f) => f.id).join(', ');
    out.push({
      facetId: id,
      output: '',
      success: false,
      errorMessage: `Unknown facet id "${id}" — registered facets: ${knownIds || '(none)'}`,
      charsConsumed: 0,
      sandbox: { mode: 'direct', applied: false, reason: 'apply-failed' },
      durationMs: 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildToolOverride(
  allowlist: readonly string[],
  baseTools: readonly ToolDefinition[] | undefined,
): ToolDefinition[] | undefined {
  if (!baseTools) {
    // Caller didn't hand us a tool catalog — the runAgentLoop call
    // will fall back to the default getToolDefinitions(). Filtering
    // happens via modeToolPermissions, which denies non-allowlisted
    // tools at dispatch time regardless of the visible catalog.
    return undefined;
  }
  const allowed = new Set(allowlist);
  return baseTools.filter((t) => allowed.has(t.name));
}

/**
 * Run each facet in a layer through the given worker, respecting a
 * concurrency cap. Same pattern as `runWithCap` in
 * `src/agent/loop/multiFileEdit.ts` but expressed in place to avoid
 * cross-module coupling between the facet runtime and the multi-file
 * edit module (they conceptually live in different subsystems).
 */
async function runLayerWithCap(
  layer: readonly FacetDefinition[],
  worker: (facet: FacetDefinition) => Promise<void>,
  cap: number,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(Math.max(1, cap), layer.length);
  async function runWorker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= layer.length) return;
      try {
        await worker(layer[i]);
      } catch {
        // worker never throws in our call site (dispatchFacet
        // absorbs exceptions into a result), but keep the catch so
        // a rogue future caller can't crash the pool.
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}
