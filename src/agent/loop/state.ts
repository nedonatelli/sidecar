import type { ChatMessage, ToolDefinition } from '../../ollama/types.js';
import { getContentLength } from '../../ollama/types.js';
import type { ApprovalMode } from '../executor.js';
import type { AgentLogger } from '../logger.js';
import type { ChangeLog } from '../changelog.js';
import type { MCPManager } from '../mcpManager.js';
import { createGateState, lastUserText } from '../completionGate.js';
import { initRatchetRunState } from './keepBestRatchetWiring.js';
import { getToolDefinitionsForTier } from '../tools.js';
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

  // F1 failure taxonomy. `termination` is set at each loop-exit point so
  // finalize() can classify the run into a failure bucket. `undefined` means
  // the loop exited via a thrown exception (finalize is called from the catch
  // path before rethrow). `unrepairedMalformedCalls` accumulates tool calls
  // whose arguments never parsed even after constrained-decoding repair.
  // finalize.ts reads both.
  //
  //   natural          — model declared done (or plan presented)
  //   aborted          — user Stop / checkpoint decline
  //   out-of-resources — token budget or request timeout
  //   max-iterations   — the iteration cap was reached
  //   stuck            — burst cap / repeated-action cycle bail
  termination?: 'natural' | 'aborted' | 'out-of-resources' | 'max-iterations' | 'stuck';
  unrepairedMalformedCalls: number;
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

  // Per-iteration write-target ring buffer for the third-pass thrash detector.
  // Each element is the list of file paths targeted by mutation tools in that
  // iteration. cycleDetection.ts is the only writer; it fires when the same
  // file appears in more iterations than WRITE_TARGET_THRESHOLD within the window.
  recentWriteTargets: string[][];

  // Per-file auto-fix retry counter. autoFix.ts is the only writer.
  autoFixRetriesByFile: Map<string, number>;

  // Per-file count of full-file overwrites (write_file) this run, and the
  // number of isolate-rewrite nudges already injected per file. isolateRewrite.ts
  // is the only writer. Used to redirect a stuck model from regenerating whole
  // files toward targeted edit_file changes *before* cycle detection bails it.
  fullRewriteCountByFile: Map<string, number>;
  isolateNudgesByFile: Map<string, number>;

  // Per-path set of content hashes written this run. The write_file executor
  // records every distinct write and soft-blocks a byte-identical re-write (a
  // no-op on disk and the signature of A→B→A circular thrash). cycleDetection
  // reads this to skip blocked circular writes so the run continues — bounded by
  // circularRewriteBlocksByFile so a model that keeps emitting identical writes
  // still bails eventually.
  writeHistoryByFile: Map<string, Set<string>>;
  circularRewriteBlocksByFile: Map<string, number>;

  // Per-path count of consecutive write_file calls with NO intervening
  // verification of that file (get_diagnostics, or a run/test referencing it).
  // The write_file executor increments + soft-blocks once it exceeds the
  // threshold; verifications reset the counter. Forces the feedback step a
  // stuck model skips — dogfooding caught qwen3.5 rewriting a GUI 7× without
  // ever running it, shipping a NameError one execution would have surfaced.
  writesSinceVerifyByFile: Map<string, number>;

  // Per-file count of times the loop deferred a write-thrash cycle bail to give
  // the verify-before-rewrite executor block a chance to push the model to run
  // get_diagnostics / a test first. Bounded so a model that ignores the push
  // still bails. circularRewrite.ts is the only writer.
  forceVerifyBeforeBailByFile: Map<string, number>;

  // Files the agent has successfully modified via edit_file this run. Once a
  // file is here, a full write_file to it is soft-blocked (the executor forces
  // continued targeted edits) — regenerating the whole file clobbers the edits,
  // and dogfooding caught write_file repeatedly re-introducing a syntax bug that
  // edit_file had just fixed. circularRewrite.ts records; fs.ts writeFile reads.
  filesEditedViaEditTool: Set<string>;

  // Per-path signature of the most recent edit_file call that failed with
  // "search and replace identical" or "search not found" (both are
  // unrecoverable-without-more-info failures — the tool can only show a hint,
  // not safely guess the intended change). A weak model frequently resubmits
  // the EXACT same failing call instead of adapting; fs.ts's editFile reads
  // this to escalate the error message on a verbatim repeat rather than
  // showing the same hint again, and clears the entry on a successful edit.
  editFailureSignatures: Map<string, string>;

  // Most recent failing verification output (test failure / traceback /
  // diagnostics error), ANSI-stripped and truncated. Surfaced inline when the
  // model loops on a blocked rewrite so it sees WHAT to fix. circularRewrite.ts
  // is the only writer.
  lastFailureOutput?: string;

  // Files for which the loop has already injected the escalation reprompt after
  // an enforce-edit-blocked rewrite (bounds the escalation to once per file).
  escalatedRewriteByFile: Set<string>;

  // Per-file count of enforce-edit-blocked write_file calls. After enough blocks
  // (the model was escalated to edit_file and ignored it), the loop RELEASES the
  // enforce-edit lock for that file so a rewrite-oriented model can rewrite
  // instead of being trapped into a bail. circularRewrite.ts is the only writer.
  enforceEditBlocksByFile: Map<string, number>;

  // Stub-validator retry counter. stubCheck.ts is the only writer.
  stubFixRetries: number;

  /**
   * How many times the action-request reprompt has fired this run.
   * Capped at 1 so a model that genuinely can't tool-call doesn't
   * loop forever — after the first reprompt it gets one more chance,
   * then the loop exits naturally.
   */
  actionRepromptCount: number;

  /**
   * Files successfully read via read_file during this loop run.
   * Persists across iterations so that a file read in iteration N is
   * still "known" in iteration N+1 when the model tries to edit it.
   * editFile consults this to inject a "you haven't read this file yet"
   * warning with a relevant file section when the model edits without
   * having read the file at all in this session.
   */
  filesReadThisRun: Set<string>;

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

  // True once the analysis fact-check critic (V2) has fired this run.
  // Fires at most once. analysisCriticHook is the only writer.
  analysisCriticFired: boolean;

  // True once the unapplied-edit nudge has fired this run. Bounds the nudge to
  // one injection so a false positive (an explanatory code block) costs at most
  // one extra message. unappliedEditHook is the only writer.
  unappliedEditNudged: boolean;

  // Capability-driven scaffolding intensity (A2). Set at loop start only when
  // `adaptiveScaffolding.enabled` is on; otherwise undefined and the loop reads
  // the historical constants. cycleDetection / actionReprompt / gate read it.
  scaffoldingProfile?: import('../scaffoldingProfile.js').ScaffoldingProfile;

  // Keep-best ratchet state (Pareto-safe scaffolding, §2.1). Present only when
  // `scaffolding.keepBest` is on and not in audit mode; `enabled=false`
  // otherwise. keepBestRatchetWiring.ts is the only reader/writer.
  ratchet?: import('./keepBestRatchetWiring.js').RatchetRunState;

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
    tools: options.toolOverride ?? getToolDefinitionsForTier(options.toolTier ?? 'full', options.mcpManager),
    logger: options.logger,
    changelog: options.changelog,
    mcpManager: options.mcpManager,

    messages: copiedMessages,
    iteration: 0,
    totalChars,
    unrepairedMalformedCalls: 0,
    systemPromptOverride: options.systemPromptOverride,
    modelOverride: options.modelOverride,

    episodicMemory: options.episodicMemory ?? new EpisodicMemoryStore(),
    recentToolCalls: [],
    recentNormalizedCalls: [],
    recentWriteTargets: [],
    autoFixRetriesByFile: new Map<string, number>(),
    fullRewriteCountByFile: new Map<string, number>(),
    isolateNudgesByFile: new Map<string, number>(),
    writeHistoryByFile: new Map<string, Set<string>>(),
    circularRewriteBlocksByFile: new Map<string, number>(),
    writesSinceVerifyByFile: new Map<string, number>(),
    forceVerifyBeforeBailByFile: new Map<string, number>(),
    filesEditedViaEditTool: new Set<string>(),
    editFailureSignatures: new Map<string, string>(),
    escalatedRewriteByFile: new Set<string>(),
    enforceEditBlocksByFile: new Map<string, number>(),
    stubFixRetries: 0,
    actionRepromptCount: 0,
    filesReadThisRun: new Set<string>(),
    criticInjectionsByFile: new Map<string, number>(),
    criticInjectionsByTestHash: new Map<string, number>(),
    analysisCriticFired: false,
    unappliedEditNudged: false,
    toolCallCounts: new Map<string, number>(),
    gateState: createGateState(lastUserText(copiedMessages)),
    currentEditPlan: null,
    checkpointFired: false,
    // Keep-best ratchet: opt-in and disabled in audit mode (writes are buffered
    // in memory there, so a disk-level revert doesn't apply).
    ratchet: initRatchetRunState(
      (options.config ?? getConfig()).keepBestRatchetEnabled === true &&
        (options.config ?? getConfig()).agentMode !== 'audit',
      (options.config ?? getConfig()).keepBestOverEngineerBytes,
    ),
  };
}
