import type { ChatMessage, ToolDefinition } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import { runAgentLoopInSandbox, type SandboxResult } from '../shadow/sandbox.js';
import type { FacetDefinition } from './facetLoader.js';
import type { FacetRegistry } from './facetRegistry.js';
import { FacetRpcBus, generateRpcTools, type RpcHandler, type RpcWireTraceEntry } from './facetRpcBus.js';

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
  /**
   * Optional RPC bus (v0.66 chunk 3.4b). When provided together with
   * `rpcPeers`, the dispatcher generates `rpc.<peerId>.<method>` tools
   * for every peer method declared in `rpcSchema` and merges them into
   * the facet's toolOverride. Peers are typically the full set of
   * facets in the same batch (minus the caller); handlers are
   * registered separately on the bus before the dispatch starts.
   */
  readonly rpcBus?: FacetRpcBus;
  readonly rpcPeers?: readonly FacetDefinition[];
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
  let toolOverride: ToolDefinition[] | undefined =
    facet.toolAllowlist && facet.toolAllowlist.length > 0
      ? buildToolOverride(facet.toolAllowlist, options.agentOptions?.toolOverride)
      : undefined;

  let modeToolPermissions: Record<string, 'allow' | 'deny' | 'ask'> | undefined = facet.toolAllowlist
    ? Object.fromEntries(facet.toolAllowlist.map((n) => [n, 'allow' as const]))
    : undefined;

  // v0.66 chunk 3.4b — merge RPC peer tools into the facet's tool
  // surface when a bus is provided. Generated tools are named
  // `rpc.<peerId>.<method>`; definitions land in `toolOverride` (what
  // the model SEES) and the executor pair lands in `extraTools`
  // (what the run-scoped executor dispatch RESOLVES to). Every one
  // is added to the allowlist so modeToolPermissions doesn't deny
  // them at dispatch time.
  let extraTools: ReturnType<typeof generateRpcTools> | undefined;
  if (options.rpcBus && options.rpcPeers && options.rpcPeers.length > 0) {
    const rpcTools = generateRpcTools(facet.id, options.rpcPeers, options.rpcBus);
    if (rpcTools.length > 0) {
      extraTools = rpcTools;
      const rpcToolDefs = rpcTools.map((t) => t.definition);
      const rpcNames = rpcToolDefs.map((d) => d.name);
      toolOverride = toolOverride ? [...toolOverride, ...rpcToolDefs] : rpcToolDefs;
      modeToolPermissions = {
        ...(modeToolPermissions ?? {}),
        ...Object.fromEntries(rpcNames.map((n) => [n, 'allow' as const])),
      };
    }
  }

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
        extraTools,
        // Autonomous — a facet is a specialist, not a user-interactive
        // session. Approval still fires for destructive tools that
        // opt in via `alwaysRequireApproval`.
        approvalMode: 'autonomous',
      },
      // Force shadow on — every facet run is sandboxed regardless of
      // the user's global shadowWorkspaceMode preference. Defer the
      // per-run prompt (v0.66 chunk 3.6): the batch's review UI runs
      // once all facets complete, so we don't stack N quickpicks.
      { forceShadow: true, deferPrompt: true },
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
 * Handler map for RPC dispatch — `{ facetId: { method: handler } }`.
 * Passed to `dispatchFacets` and registered on the per-batch bus
 * BEFORE any facet loop starts. The dispatcher clears handlers on
 * the receiver facet's completion (success or failure) so later calls
 * surface as `no-handler` rather than hitting stale closures.
 */
export type FacetRpcHandlerMap = Readonly<Record<string, Readonly<Record<string, RpcHandler>>>>;

/**
 * Batch result from `dispatchFacets` (v0.66 chunk 3.4b). Carries the
 * per-facet results plus the full RPC wire trace from the bus used
 * during dispatch. The trace feeds the Facet Comms UI (chunk 3.5)
 * and per-run review (chunk 3.6); it's always present but empty
 * when no RPC calls fired.
 */
export interface FacetDispatchBatchResult {
  readonly results: readonly FacetDispatchResult[];
  readonly rpcWireTrace: readonly RpcWireTraceEntry[];
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
 * v0.66 chunk 3.4b — sets up a fresh `FacetRpcBus` per batch. Callers
 * can supply `rpcHandlers` mapping `{ facetId: { method: handler } }`;
 * those handlers are registered before any facet loop starts so
 * calls fired via generated `rpc.<peerId>.<method>` tools resolve
 * synchronously. When `rpcHandlers` is omitted, every RPC call
 * surfaces to the model as `[rpc-error:no-handler]` — the primitive
 * is still installed on each facet's tool surface but the wire trace
 * records every failed attempt for debugging.
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
  options: DispatchFacetOptions & {
    maxConcurrent: number;
    /** Milliseconds for RPC timeout; defaults to 30s. */
    rpcTimeoutMs?: number;
    /** Handlers to register on the per-batch RPC bus before dispatch. */
    rpcHandlers?: FacetRpcHandlerMap;
  },
): Promise<FacetDispatchBatchResult> {
  // Build a fresh bus per batch so wire traces never bleed across
  // independent runs. Handlers supplied by the caller get registered
  // before any facet loop starts; the bus itself lives for the
  // duration of this call and is abandoned when we return.
  const bus = new FacetRpcBus({ timeoutMs: options.rpcTimeoutMs ?? 30_000 });
  if (options.rpcHandlers) {
    for (const [facetId, methods] of Object.entries(options.rpcHandlers)) {
      for (const [method, handler] of Object.entries(methods)) {
        bus.registerHandler(facetId, method, handler);
      }
    }
  }

  if (facetIds.length === 0) {
    return { results: [], rpcWireTrace: bus.getWireTrace() };
  }

  // Resolve facet IDs → definitions. Unknown ids become synthetic
  // error results at the end; valid ids feed the layered dispatch.
  const resolved: FacetDefinition[] = [];
  for (const id of facetIds) {
    const facet = registry.get(id);
    if (facet) resolved.push(facet);
  }

  // Peers = every resolved facet. `generateRpcTools` inside
  // dispatchFacet excludes each facet's own entry so self-RPC can't
  // be attempted.
  const rpcPeers: readonly FacetDefinition[] = resolved;

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
        try {
          const r = await dispatchFacet(client, facet, parentCallbacks, {
            ...options,
            rpcBus: bus,
            rpcPeers,
          });
          resultsById.set(facet.id, r);
        } finally {
          // Clear THIS facet's handlers on completion so subsequent
          // calls from later-layer facets surface as no-handler
          // (otherwise a caller could invoke a handler whose facet
          // has already torn down). Callers who want handlers to
          // survive register them on the caller-side via a closure
          // that owns the state instead.
          bus.clearFacetHandlers(facet.id);
        }
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
  return { results: out, rpcWireTrace: bus.getWireTrace() };
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
