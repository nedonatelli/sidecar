import type { ChatMessage, ToolDefinition } from '../../ollama/types.js';
import { getContentLength } from '../../ollama/types.js';
import type { ApprovalMode } from '../executor.js';
import type { AgentLogger } from '../logger.js';
import type { ChangeLog } from '../changelog.js';
import type { MCPManager } from '../mcpManager.js';
import { createGateState } from '../completionGate.js';
import { getToolDefinitions } from '../tools.js';
import type { AgentOptions } from '../loop.js';
import type { EditPlan } from '../editPlan.js';
import { type SideCarConfig, getConfig } from '../../config/settings.js';
import { EpisodicMemoryStore } from '../episodicMemory.js';

// ---------------------------------------------------------------------------
// Shared mutable + immutable state for runAgentLoop.
//
// Before this extraction, runAgentLoop held about 15 variables in a
// single 770-line closure — message array, iteration counter, char
// total, cycle-detection ring buffer, per-file retry maps, gate
// state, and so on. Every helper we now factor out needs access to
// some subset. Passing 15 params everywhere is painful and fragile;
// passing one `LoopState` by reference is clean and makes the
// dependency graph obvious.
//
// Contract:
//
//   - **Readonly fields** are set once by `initLoopState` and must
//     not be mutated after. Marked `readonly` for documentation and
//     to catch accidental reassignment at compile time.
//
//   - **Mutable fields** are deliberately shared. Helpers may push
//     to `messages`, increment `iteration`, decrement `totalChars`,
//     etc. The convention is: helpers own their subset of fields
//     and don't touch others. For example, `compression.ts` is the
//     only thing that decrements `totalChars` from summarization,
//     and `executeToolUses.ts` is the only thing that bumps it
//     from tool calls.
//
//   - **Sub-state objects** (`gateState`, the retry maps) live on
//     `LoopState` so they flow through helpers without needing
//     separate parameters.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ITERATIONS = 25;

/** One entry in the normalized-call ring buffer. */
export interface NormalizedEntry {
  /** `tool:primaryResource` — the part that identifies "same operation on same target". */
  sig: string;
  /** Fingerprint of all args except the primary resource. All-unique secondary hashes
   * within a streak means the agent is trying different approaches; a repeat means stuck. */
  secondaryHash: string;
}

export interface LoopState {
  // --- Immutable inputs captured at init ---
  readonly startTime: number;
  readonly runId: string;
  /**
   * Config snapshot captured at loop entry from `options.config ?? getConfig()`.
   * Stored here so every submodule reads the same values for the duration of
   * a run and tests can inject a mock config via AgentOptions without stubbing
   * the global.
   */
  readonly config: SideCarConfig;
  readonly maxIterations: number;
  readonly maxTokens: number;
  readonly approvalMode: ApprovalMode;
  readonly tools: ToolDefinition[];
  readonly logger: AgentLogger | undefined;
  readonly changelog: ChangeLog | undefined;
  readonly mcpManager: MCPManager | undefined;

  // --- Mutable state across iterations ---
  messages: ChatMessage[];
  iteration: number;
  totalChars: number;
  /**
   * Actual input+output token count from the most recent API usage event.
   * When present, compression checks prefer this over the char-based estimate
   * because it reflects the provider's real tokenization. Reset to undefined
   * after compression fires (since we've modified the message history and the
   * cached count no longer applies to the new context).
   */
  lastActualInputTokens?: number;

  // Session-scoped episodic memory: summaries of compressed turns are
  // embedded here so semantically relevant prior context can be
  // retrieved and injected into the system prompt on future turns.
  // episodicMemory.ts is the only thing that writes it; streamTurn.ts
  // queries it before each LLM call.
  episodicMemory: EpisodicMemoryStore;

  // Ring buffer of recent tool-call signatures for cycle detection.
  // cycleDetection.ts is the only thing that reads or writes it.
  recentToolCalls: string[];

  // Parallel ring buffer of normalized call entries (tool + primary resource +
  // secondary-args fingerprint). Used by the normalized-cycle check in
  // cycleDetection.ts. Storing the secondary-args hash alongside the sig lets
  // the check distinguish "same tool on same file, different content each time"
  // (legitimate multi-step edits) from "same tool on same file, same content
  // repeated" (stuck loop).
  recentNormalizedCalls: NormalizedEntry[];

  // Per-file auto-fix retry counter. autoFix.ts is the only writer.
  autoFixRetriesByFile: Map<string, number>;

  // Stub-validator retry counter. stubCheck.ts is the only writer.
  stubFixRetries: number;

  // Per-file critic injection counter. criticHook.ts is the only writer.
  criticInjectionsByFile: Map<string, number>;

  // Per-test-output-hash critic injection counter. Bounds
  // the `test_failure` trigger path which was otherwise unbounded —
  // if tests keep failing with the SAME normalized output, the
  // critic used to re-fire every turn and could burn $1-2 of spend
  // before the outer maxIterations cap tripped. Now capped at
  // MAX_CRITIC_INJECTIONS_PER_TEST_HASH. criticHook.ts is the only
  // writer. Keyed by a normalized hash (timestamps + memory addresses
  // stripped) so cosmetic re-runs of the same failure collapse.
  criticInjectionsByTestHash: Map<string, number>;

  // Per-tool call counts for budget enforcement. toolBudget.ts is
  // the only reader; executeToolUses.ts is the only writer.
  toolCallCounts: Map<string, number>;

  // Completion-gate state (tracks edited files and verification calls).
  // gate.ts + executeToolUses.ts both touch it.
  gateState: ReturnType<typeof createGateState>;

  // Set to true after the 60%-iteration checkpoint fires so it never
  // re-fires on later iterations.
  checkpointFired: boolean;

  // Active multi-file edit plan, set by dispatchPendingToolUses for
  // the duration of a multi-file write batch .
  // Hooks + review flows (regression guards, audit mode review, shadow
  // workspace accept prompts) can read this to detect "this turn's
  // writes all belong to one plan" and present them as a grouped unit
  // rather than N independent changes. Cleared to null when the turn
  // is a normal non-planned batch.
  currentEditPlan: EditPlan | null;

  // When set, streamOneTurn passes this to client.streamChat() instead of
  // the shared client.systemPrompt. Used by concurrent sub-runs (Facets,
  // sub-agents) to avoid the updateSystemPrompt/restore race on the
  // shared client object.
  readonly systemPromptOverride?: string;
  // When set, every streamChat call for this run uses this model instead
  // of client.model. Used by concurrent Facet/fork runs to avoid the
  // setTurnOverride/restore race on the shared client object.
  readonly modelOverride?: string;
}

/**
 * Construct a fresh LoopState from the user-supplied message history
 * and agent options. Called once at the top of `runAgentLoop`, before
 * the iteration loop starts.
 *
 * The `messages` input is copied — the loop never mutates the caller's
 * array. Initial `totalChars` is computed by summing content length
 * across the copied history so compression thresholds account for the
 * full conversation, not just new output.
 */
export function initLoopState(messages: ChatMessage[], options: AgentOptions): LoopState {
  const copiedMessages = [...messages];
  let totalChars = 0;
  for (const msg of copiedMessages) {
    totalChars += getContentLength(msg.content);
  }

  return {
    startTime: Date.now(),
    runId: crypto.randomUUID(),
    config: options.config ?? getConfig(),
    maxIterations: options.maxIterations || DEFAULT_MAX_ITERATIONS,
    maxTokens: options.maxTokens || 100_000,
    approvalMode: options.approvalMode || 'cautious',
    tools: options.toolOverride ?? getToolDefinitions(options.mcpManager),
    logger: options.logger,
    changelog: options.changelog,
    mcpManager: options.mcpManager,

    messages: copiedMessages,
    iteration: 0,
    totalChars,
    systemPromptOverride: options.systemPromptOverride,
    modelOverride: options.modelOverride,

    episodicMemory: new EpisodicMemoryStore(),
    recentToolCalls: [],
    recentNormalizedCalls: [],
    autoFixRetriesByFile: new Map<string, number>(),
    stubFixRetries: 0,
    criticInjectionsByFile: new Map<string, number>(),
    criticInjectionsByTestHash: new Map<string, number>(),
    toolCallCounts: new Map<string, number>(),
    gateState: createGateState(),
    currentEditPlan: null,
    checkpointFired: false,
  };
}
