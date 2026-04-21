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

export interface LoopState {
  // --- Immutable inputs captured at init ---
  readonly startTime: number;
  readonly taskId: string;
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

  // Ring buffer of recent tool-call signatures for cycle detection.
  // cycleDetection.ts is the only thing that reads or writes it.
  recentToolCalls: string[];

  // Per-file auto-fix retry counter. autoFix.ts is the only writer.
  autoFixRetriesByFile: Map<string, number>;

  // Stub-validator retry counter. stubCheck.ts is the only writer.
  stubFixRetries: number;

  // Per-file critic injection counter. criticHook.ts is the only writer.
  criticInjectionsByFile: Map<string, number>;

  // Per-test-output-hash critic injection counter (v0.63.0). Bounds
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

  // Active multi-file edit plan, set by dispatchPendingToolUses for
  // the duration of a multi-file write batch (v0.65 chunk 4.5a).
  // Hooks + review flows (regression guards, audit mode review, shadow
  // workspace accept prompts) can read this to detect "this turn's
  // writes all belong to one plan" and present them as a grouped unit
  // rather than N independent changes. Cleared to null when the turn
  // is a normal non-planned batch.
  currentEditPlan: EditPlan | null;
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
    taskId: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
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

    recentToolCalls: [],
    autoFixRetriesByFile: new Map<string, number>(),
    stubFixRetries: 0,
    criticInjectionsByFile: new Map<string, number>(),
    criticInjectionsByTestHash: new Map<string, number>(),
    toolCallCounts: new Map<string, number>(),
    gateState: createGateState(),
    currentEditPlan: null,
  };
}
