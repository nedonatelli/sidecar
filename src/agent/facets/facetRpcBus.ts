import type { RegisteredTool, ToolExecutorContext } from '../tools/shared.js';
import type { FacetDefinition } from './facetLoader.js';

// ---------------------------------------------------------------------------
// Facet RPC bus (v0.66 chunk 3.4a).
//
// Each facet can declare a typed `rpcSchema` — a map of method names
// that peer facets may invoke. At dispatch time the bus generates one
// `rpc.<facetId>.<methodName>` tool per peer method and exposes it to
// the caller facet's agent loop. When the caller invokes that tool,
// the bus routes the call to the receiver's registered handler and
// returns the result to the caller's loop, synchronously from its POV.
//
// Scope for this chunk:
//   - `FacetRpcBus` — thread-safe-by-single-thread call registry with
//     timeout + wire-trace logging. No cross-loop coordination
//     (caller and receiver are expected to run in the same process
//     and register/call through the same bus instance).
//   - `generateRpcTools(peers, bus)` — produces `RegisteredTool[]` so
//     the facet dispatcher (chunk 3.4b) can merge them into each
//     facet's toolOverride.
//
// Design tradeoff — the receiver's "handler" is a synchronous callback
// the dispatcher layer registers on behalf of each facet. A fully
// bidirectional in-loop RPC (facet A pauses until facet B's loop
// surfaces the call, answers it, and returns) is genuinely complex
// and not strictly necessary for the common case: one-way publish
// (publishMathBlock) + quick lookup (requestSymbolDefinition) both
// work with synchronous handlers backed by shared state.
// ---------------------------------------------------------------------------

/**
 * The body of an RPC call. The runtime does NOT validate this against
 * the facet's declared `rpcSchema.params` — that's a hint for the
 * model + the receiver's handler. We keep the wire shape open so a
 * mismatched call surfaces as a handler-side rejection rather than a
 * bus-side schema error (the handler knows best what to reject).
 */
export type RpcArgs = Record<string, unknown>;

/** Handler registered by the receiver facet for a specific method. */
export type RpcHandler = (args: RpcArgs, context: RpcCallContext) => Promise<unknown> | unknown;

/** Passed to the handler so it can attribute the call in logs. */
export interface RpcCallContext {
  readonly callerFacetId: string;
  readonly receiverFacetId: string;
  readonly method: string;
  readonly startedAt: number;
}

/** One entry in the wire-trace log — every RPC attempt is recorded. */
export interface RpcWireTraceEntry {
  readonly callerFacetId: string;
  readonly receiverFacetId: string;
  readonly method: string;
  readonly args: RpcArgs;
  readonly outcome: 'ok' | 'timeout' | 'no-handler' | 'handler-threw';
  readonly result?: unknown;
  readonly errorMessage?: string;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface FacetRpcBusOptions {
  /**
   * Milliseconds a single `call()` may wait before returning a
   * synthetic `timeout` result. Matches
   * `sidecar.facets.rpcTimeoutMs` (chunk 3.3 settings).
   */
  readonly timeoutMs: number;
}

/**
 * Process-local bus instance. Each batch dispatch (`dispatchFacets`)
 * creates a fresh bus so wire traces don't bleed across independent
 * runs. Handlers are registered by the dispatcher on behalf of each
 * facet before that facet's loop starts; calls fired during the
 * loop route through the bus and return to the caller's loop as
 * tool_result blocks.
 */
export class FacetRpcBus {
  private handlers = new Map<string, RpcHandler>();
  private trace: RpcWireTraceEntry[] = [];
  private readonly timeoutMs: number;

  constructor(options: FacetRpcBusOptions) {
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Register a handler for `receiverFacetId.method`. Overwriting is
   * allowed (later dispatches of the same facet can replace a stale
   * handler from a previous batch, though in practice each bus is
   * per-batch so this is an edge).
   */
  registerHandler(receiverFacetId: string, method: string, handler: RpcHandler): void {
    this.handlers.set(keyOf(receiverFacetId, method), handler);
  }

  /**
   * Clear every handler for `receiverFacetId`. Called when a facet's
   * loop tears down (success or failure) so subsequent calls to
   * methods on that facet surface as `no-handler` rather than hitting
   * a callback that references stale state.
   */
  clearFacetHandlers(receiverFacetId: string): void {
    for (const k of this.handlers.keys()) {
      if (k.startsWith(`${receiverFacetId}::`)) {
        this.handlers.delete(k);
      }
    }
  }

  /**
   * Invoke `receiverFacetId.method` with `args` on behalf of the
   * caller. Resolves to the handler's return value, or a synthetic
   * error record on timeout / missing handler / handler throw. Never
   * rejects — a facet tool executor must not raise back into the
   * agent loop because that would end the turn abruptly; we always
   * resolve to a shape the model can read and react to.
   */
  async call(
    callerFacetId: string,
    receiverFacetId: string,
    method: string,
    args: RpcArgs,
  ): Promise<
    | {
        ok: true;
        value: unknown;
      }
    | {
        ok: false;
        errorKind: 'no-handler' | 'timeout' | 'handler-threw';
        message: string;
      }
  > {
    const startedAt = Date.now();
    const handler = this.handlers.get(keyOf(receiverFacetId, method));
    if (!handler) {
      this.trace.push({
        callerFacetId,
        receiverFacetId,
        method,
        args,
        outcome: 'no-handler',
        errorMessage: `No handler registered for ${receiverFacetId}.${method}`,
        startedAt,
        finishedAt: Date.now(),
      });
      return {
        ok: false,
        errorKind: 'no-handler',
        message: `No facet handler registered for ${receiverFacetId}.${method} — ensure the peer is part of this dispatch batch`,
      };
    }

    const ctx: RpcCallContext = { callerFacetId, receiverFacetId, method, startedAt };
    // Wrap the handler call in an async IIFE so sync throws surface as
    // rejections we can catch below. Without this, a `throw 'x'` inside
    // a non-async handler escapes before Promise.resolve wraps it.
    const execute = (async () => handler(args, ctx))();
    const timeout = new Promise<'__rpc_timeout__'>((resolve) =>
      setTimeout(() => resolve('__rpc_timeout__'), this.timeoutMs),
    );

    try {
      const outcome = await Promise.race([execute, timeout]);
      if (outcome === '__rpc_timeout__') {
        this.trace.push({
          callerFacetId,
          receiverFacetId,
          method,
          args,
          outcome: 'timeout',
          errorMessage: `RPC ${receiverFacetId}.${method} timed out after ${this.timeoutMs}ms`,
          startedAt,
          finishedAt: Date.now(),
        });
        return {
          ok: false,
          errorKind: 'timeout',
          message: `RPC call ${receiverFacetId}.${method} exceeded ${this.timeoutMs}ms`,
        };
      }
      this.trace.push({
        callerFacetId,
        receiverFacetId,
        method,
        args,
        outcome: 'ok',
        result: outcome,
        startedAt,
        finishedAt: Date.now(),
      });
      return { ok: true, value: outcome };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.trace.push({
        callerFacetId,
        receiverFacetId,
        method,
        args,
        outcome: 'handler-threw',
        errorMessage: msg,
        startedAt,
        finishedAt: Date.now(),
      });
      return {
        ok: false,
        errorKind: 'handler-threw',
        message: `RPC handler ${receiverFacetId}.${method} threw: ${msg}`,
      };
    }
  }

  /** Snapshot of the full wire trace. Safe for readers to retain. */
  getWireTrace(): readonly RpcWireTraceEntry[] {
    return this.trace.slice();
  }

  /** Count of registered handlers (for tests + UI health checks). */
  handlerCount(): number {
    return this.handlers.size;
  }
}

/**
 * Build `RegisteredTool[]` entries for every method the `peers` list
 * declares. One tool per `receiverFacetId × methodName`, named
 * `rpc.<facetId>.<method>`. The tool's executor routes through `bus`,
 * attributing the call to `callerFacetId` supplied at generation time.
 *
 * Called by the dispatcher once per facet being dispatched (each
 * facet gets its own set of peer tools).
 */
export function generateRpcTools(
  callerFacetId: string,
  peers: readonly FacetDefinition[],
  bus: FacetRpcBus,
): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  for (const peer of peers) {
    if (peer.id === callerFacetId) continue; // never call yourself via RPC
    if (!peer.rpcSchema) continue;
    for (const [methodName, schema] of Object.entries(peer.rpcSchema)) {
      const toolName = `rpc.${peer.id}.${methodName}`;
      // Describe the peer's surface to the model so it knows when to
      // use this tool. We inline the declared params shape into the
      // description rather than trying to flow it into input_schema
      // (which would require a full JSON-Schema builder pass).
      const paramsHint = schema.params ? ` Params: ${JSON.stringify(schema.params)}.` : '';
      const returnsHint = schema.returns ? ` Returns: ${JSON.stringify(schema.returns)}.` : '';
      tools.push({
        definition: {
          name: toolName,
          description:
            `RPC call to the ${peer.displayName} facet's ${methodName} method.${paramsHint}${returnsHint} ` +
            `Arguments are passed verbatim as JSON under \`args\`.`,
          input_schema: {
            type: 'object',
            properties: {
              args: {
                type: 'object',
                description: 'Arguments object passed to the peer method.',
              },
            },
            required: ['args'],
          },
        },
        executor: async (input: Record<string, unknown>, _context?: ToolExecutorContext) => {
          const args = (input.args as RpcArgs | undefined) ?? {};
          const outcome = await bus.call(callerFacetId, peer.id, methodName, args);
          if (outcome.ok) {
            return typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value);
          }
          return `[rpc-error:${outcome.errorKind}] ${outcome.message}`;
        },
        requiresApproval: false,
      });
    }
  }
  return tools;
}

/**
 * Format a wire trace as a plain-text block for the Facet Comms UI
 * (chunk 3.5) and review (chunk 3.6). One line per call; failure
 * outcomes surface the error message inline.
 */
export function formatWireTrace(trace: readonly RpcWireTraceEntry[]): string {
  if (trace.length === 0) return '(no RPC calls)';
  const lines: string[] = [];
  for (const entry of trace) {
    const ms = entry.finishedAt - entry.startedAt;
    const argPreview = JSON.stringify(entry.args).slice(0, 80);
    const base = `${entry.callerFacetId} → ${entry.receiverFacetId}.${entry.method}(${argPreview}) [${ms}ms]`;
    if (entry.outcome === 'ok') {
      const resultPreview = JSON.stringify(entry.result).slice(0, 80);
      lines.push(`${base} → ${resultPreview}`);
    } else {
      lines.push(`${base} → ${entry.outcome}: ${entry.errorMessage}`);
    }
  }
  return lines.join('\n');
}

// Private key builder — `receiverFacetId::method` so two handler
// entries don't collide when `receiverFacetId` happens to contain `.`.
function keyOf(receiverFacetId: string, method: string): string {
  return `${receiverFacetId}::${method}`;
}
