import { runAgentLoop, type AgentCallbacks, type AgentOptions } from '../../src/agent/loop.js';
import { SideCarClient } from '../../src/ollama/client.js';
import { getToolDefinitionsForTier } from '../../src/agent/tools.js';
import { hash as surfaceHash } from '../../bench/promptlab/manifest.js';
import { createTrajectoryLogger, type TrajectoryLogger } from './trajectoryLog.js';
import type { ChatMessage } from '../../src/ollama/types.js';
import type { EffectiveSurface } from './agentHarness.js';

// ---------------------------------------------------------------------------
// The shared middle of both eval harnesses.
//
// `swe.eval.ts` imported `runAgentLoop` directly and re-implemented what
// `agentHarness.ts` already did: client construction, system-prompt assignment,
// abort/timeout, callbacks, trajectory logging, surface recording. Two harnesses
// answered the same question — drive a model against a workspace with tools and
// record what happened — and which answer you got depended on which file ran.
//
// The divergences were not cosmetic. RAG orientation was injected on every SWE
// task and nowhere else; `backend: 'ollama'` was hardcoded in SWE, so no
// frontier ceiling run was ever possible; the two carried separate failure
// taxonomies and separate timeout semantics. See
// docs/superpowers/specs/2026-08-20-harness-unification-design.md.
//
// A SESSION rather than a one-shot call: agentHarness may re-enter the loop with
// a continuation (its cooperative reply to a clarifying question), while SWE
// runs once. Owning the client, abort signal and logger across both invocations
// is the whole reason that continuation could not simply call a function.
// ---------------------------------------------------------------------------

export interface TurnLoopInput {
  model: string;
  baseUrl: string;
  apiKey: string;
  systemPrompt: string;
  options: AgentOptions;
  callbacks: AgentCallbacks;
  timeoutMs: number;
  /** Identity for the trajectory log; also what makes two runs comparable. */
  caseId: string;
  arm: string;
  trial: number;
  /** Chars of RAG orientation prepended by the caller — 0 means it did not fire. */
  ragOrientationChars: number;
  logDir?: string | null;
  /** Injected for tests; defaults to the real loop. */
  loopFn?: typeof runAgentLoop;
}

export interface TurnLoopSession {
  readonly surface: EffectiveSurface;
  readonly signal: AbortSignal;
  readonly logger: TrajectoryLogger | null;
  run(messages: ChatMessage[]): Promise<void>;
  /** Clears the timeout and flushes the log. Safe to call more than once. */
  close(termination: string): { durationMs: number; timedOut: boolean };
}

export function createTurnLoopSession(input: TurnLoopInput): TurnLoopSession {
  const started = Date.now();
  const client = new SideCarClient(input.model, input.baseUrl, input.apiKey);
  client.updateSystemPrompt(input.systemPrompt);

  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, input.timeoutMs);

  // Computed from the values actually used, never from the ones intended. An arm
  // was once described as "no RAG" while project_knowledge_search sat in its
  // catalog the whole time, because nothing recorded the catalog.
  const cfg = input.options.config as { agentTemperature?: number } | undefined;
  // Resolving the catalog reads config the caller may not have populated (custom
  // tools, MCP). Surface capture is telemetry: it records what it can and never
  // takes down the run it is describing.
  let effectiveTools: { name: string }[] = [];
  try {
    effectiveTools =
      input.options.toolOverride ??
      getToolDefinitionsForTier(input.options.toolTier ?? 'full', input.options.mcpManager, input.options.config);
  } catch {
    effectiveTools = [];
  }
  const seedEnv = process.env.SIDECAR_AGENT_SEED;
  const surface: EffectiveSurface = {
    systemPromptChars: input.systemPrompt.length,
    systemPromptHash: surfaceHash(input.systemPrompt),
    toolNames: effectiveTools.map((t) => t.name).sort(),
    toolCatalogHash: surfaceHash(JSON.stringify(effectiveTools)),
    ragOrientationChars: input.ragOrientationChars,
    seed: seedEnv ? Number(seedEnv) : null,
    temperature: cfg?.agentTemperature ?? NaN,
    numCtx: process.env.SIDECAR_OLLAMA_NUM_CTX ? Number(process.env.SIDECAR_OLLAMA_NUM_CTX) : null,
  };

  const logger =
    input.logDir === null || process.env.SIDECAR_EVAL_TRAJECTORY_DIR === 'off'
      ? null
      : createTrajectoryLogger({
          // SIDECAR_EVAL_TRAJECTORY_DIR is how a sweep isolates its logs; honoring
          // it here means both harnesses obey the same variable instead of one
          // silently writing every arm into the same directory.
          dir: input.logDir ?? `${process.env.SIDECAR_EVAL_TRAJECTORY_DIR || '.sidecar/logs/eval-trajectories'}/live`,
          caseId: input.caseId,
          arm: input.arm,
          seed: surface.seed,
          trial: input.trial,
          surface,
          configOverrides: (input.options.config ?? {}) as Record<string, unknown>,
        });

  const callbacks = logger ? logger.wrap(input.callbacks) : input.callbacks;
  const loop = input.loopFn ?? runAgentLoop;
  let closed = false;

  return {
    surface,
    signal: abort.signal,
    logger,
    async run(messages: ChatMessage[]) {
      await loop(client, messages, callbacks, abort.signal, input.options);
    },
    close(termination: string) {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        logger?.close(timedOut ? `${termination} (TIMEOUT)` : termination);
      }
      return { durationMs: Date.now() - started, timedOut };
    },
  };
}
