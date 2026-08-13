import type { WorkspaceFixture } from './workspaceSandbox.js';

// ---------------------------------------------------------------------------
// Types for the agent-loop eval layer.
//
// The existing types.ts covers the prompt-only layer: user message in,
// model response out, string-based expectations. The agent-loop layer
// is shaped differently: the agent runs *tools* and *mutates a
// workspace*, so cases need to declare a workspace fixture and the
// expectations have to reach into trajectory (what tools were called)
// and workspace state (what files exist / contain after the run).
//
// We keep the two layers side-by-side instead of unifying them — the
// prompt layer is simpler and more deterministic, and any future
// mixed-mode case can compose its own predicates from both.
// ---------------------------------------------------------------------------

/**
 * One recorded event from the agent loop. The harness collects these
 * via AgentCallbacks and scorers walk the list to check trajectory
 * expectations ("was read_file called with path=x?").
 *
 * This is a minimal shape — we record only the fields scorers
 * actually use, plus enough context for the failure report. If we
 * later need, say, timing or token counts per event, add optional
 * fields without breaking the discriminated union shape.
 */
export type TrajectoryEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call'; name: string; input: Record<string, unknown>; id: string }
  | { type: 'tool_result'; name: string; result: string; isError: boolean; id: string }
  | { type: 'done' };

/**
 * An agent-loop evaluation case.
 *
 * Each case owns its workspace fixture (so cases can't interfere with
 * each other), a user message, and a set of assertions that run against
 * the recorded trajectory and the post-run workspace state.
 */
export interface AgentEvalCase {
  /** Stable identifier shown in the report. */
  id: string;
  /** One-line description for the report. */
  description: string;
  /** Tags for filtering. Useful: 'read', 'edit', 'search', 'trajectory', 'regression'. */
  tags: string[];
  /** Files materialized into a temp-dir workspace before the case runs. */
  workspace: WorkspaceFixture;
  /** The user message the agent receives. */
  userMessage: string;
  /**
   * Assertion block. Each key is an optional predicate evaluated
   * against the captured trajectory or the post-run workspace
   * snapshot. A case passes only when every declared predicate holds.
   */
  expect: AgentExpectations;
  /**
   * Soft expectations: evaluated and reported like `expect`, but
   * failures here do NOT affect `passed`. Use for answer-quality checks
   * (e.g. "final text contains the count") when the core behavioral
   * signal is in `expect` (e.g. "used the right tool with the right
   * pattern"). Soft failures appear as a separate section in the report.
   */
  softExpect?: AgentExpectations;
  /**
   * Shell commands run in the sandbox root after files are materialized
   * and before the agent starts. Use this to set up git state (init,
   * stage changes, create commits) that the agent's git tools will see.
   * Commands run via execSync with cwd=sandbox.root; any failure throws.
   */
  setupCommands?: string[];
  /**
   * Prior conversation turns injected before the user message. Use this
   * to warm-start the model with a prior tool-use example so it doesn't
   * face a cold-start where it has never used tools in this session.
   *
   * In production SideCar the model almost always has prior context —
   * chat history, visible tool calls, injected file content — which primes
   * it toward tool use. The eval harness defaults to a single-message
   * cold start which is unrepresentative and systematically penalises
   * small models that need prior context to enter tool-use mode.
   *
   * Format: alternating user/assistant turns. Tool_use and tool_result
   * blocks are valid content so you can show a real prior tool call.
   */
  setupMessages?: import('../../src/ollama/types.js').ChatMessage[];
  /**
   * Keep `setupMessages` even for cold-start models (which normally drop
   * them — prior context flips those models out of tool-use mode). Set on
   * cases where the seeded history IS the thing under test (multi-turn
   * latch cases): dropping it there silently converts the case into a
   * trivial single-turn pass.
   */
  setupMessagesRequired?: boolean;
  /**
   * Agent loop options. Defaults: approvalMode='autonomous',
   * maxIterations=8 (eval cases should be focused — runaway loops
   * almost always mean the case is wrong or the model regressed).
   */
  approvalMode?: 'autonomous' | 'cautious' | 'manual' | 'plan' | 'review';
  maxIterations?: number;
  /** Token budget override — set LOW to force compression mid-run (long-horizon cases). */
  maxTokens?: number;
  /**
   * Harness-seeded plan source (S1): parsed via parsePlanFromText and passed
   * as AgentOptions.initialPlan — but only when the merged run config has
   * planExternalizedEnabled, so the ablation dimension controls seeding.
   * Mirrors production, where plan-mode approval seeds the plan.
   */
  seedPlanText?: string;
  /**
   * Partial config overrides merged over the defaults for this run.
   * Use to opt-in to features that are off by default (impact gate,
   * autoFix). Example: `{ impactGateEnabled: true }`.
   */
  configOverrides?: Partial<import('../../src/config/settings.js').SideCarConfig>;
  /**
   * Simulated user reply when the agent calls `ask_user`. The test plays a
   * COOPERATIVE user: a clarifying question is a legitimate step, so the harness
   * answers it and lets the agent continue to address the issue rather than
   * treating the question as a dead-end. A string is returned verbatim; a
   * function receives the model's question + offered options and returns the
   * reply. Omit to use the harness default ("proceed, use your best judgment").
   */
  clarifyResponse?: string | ((question: string, options: string[]) => string);
  /**
   * Live MCPManager for cases that exercise real MCP servers (lazy schema
   * loading, describe_tool round-trips, the mutation-verify gate). The case
   * owner connects/disconnects it — the harness only threads it into
   * AgentOptions so MCP tools appear in the catalog and gate bookkeeping
   * sees server attribution.
   */
  mcpManager?: import('../../src/agent/mcpManager.js').MCPManager;
}

/**
 * Predicates the scorer evaluates against an agent run.
 *
 * Design intent: these are all deterministic — string matching,
 * regex, presence-in-trajectory. LLM-as-judge scoring is explicitly
 * deferred to a later iteration (see README) because deterministic
 * checks give crisper regression signal and don't need a second model
 * hop to run.
 */
export interface AgentExpectations {
  /** Tool names that must appear at least once in the trajectory. */
  toolsCalled?: string[];
  /** At least one of these tool names must appear in the trajectory (OR semantics). */
  toolsCalledAny?: string[];
  /** Tool names that must NOT appear in the trajectory (e.g. no write tools for a read-only case). */
  toolsNotCalled?: string[];
  /**
   * Specific tool-call+input pairs that must appear. Input is a
   * partial match — the recorded call's input must contain every
   * key/value in the expected object, but may have additional keys.
   */
  toolCallMatches?: Array<{ name: string; inputPartial: Record<string, unknown> }>;
  /**
   * Tool-call+input pairs that must NOT appear. Same partial/substring
   * matching as `toolCallMatches`; omit `name` to forbid the input shape on
   * any tool. Built for multi-turn latch cases — "no call whose path
   * references the PREVIOUS task's file" is not expressible with
   * `toolsNotCalled` (the tool itself is legitimate, the argument is the
   * perseveration signal).
   */
  toolCallNotMatches?: Array<{ name?: string; inputPartial: Record<string, unknown> }>;
  /**
   * Post-run workspace state assertions, evaluated after the agent
   * loop finishes. The sandbox.snapshot() result is passed to each
   * assertion.
   */
  files?: {
    /** File must exist in the post-run workspace. */
    exist?: string[];
    /** File must NOT exist (e.g. it was deleted). */
    notExist?: string[];
    /** File must contain every listed substring (case-sensitive). */
    contain?: Array<{ path: string; substrings: string[] }>;
    /** File must NOT contain any listed substring (e.g. old code removed). */
    notContain?: Array<{ path: string; substrings: string[] }>;
    /** File content must match every listed regex (use when substring alternatives exist, e.g. `test(` vs `it(`). */
    matchesRegex?: Array<{ path: string; patterns: RegExp[] }>;
    /** File's content, after the run, must exactly equal the expected string. */
    equal?: Array<{ path: string; content: string }>;
    /** File must not have been modified — its post-run content must equal the pre-run content from the workspace fixture. */
    notModified?: string[];
  };
  /**
   * Assistant final-text predicates (case-insensitive substring). Each element
   * is required, EXCEPT an inner array which is an any-of synonym group — at
   * least one of its members must appear. This keeps the assertion robust to
   * paraphrase: `['clamp', ['utils.ts', 'utils']]` requires "clamp" and either
   * "utils.ts" or "utils"; `[['greet', 'hello', 'welcome']]` accepts any of the
   * three ways a model might describe a greeting function.
   */
  finalTextContains?: Array<string | string[]>;
  finalTextNotContains?: string[];
  /**
   * Regex patterns the final assistant text must match. Complements
   * `finalTextContains` for structural patterns — e.g. `/v\d+\.\d+/` to
   * verify a version string format rather than just the letter "v".
   * Patterns are tested against the full concatenated final text as-is
   * (no case folding — include the `i` flag explicitly if needed).
   */
  finalTextMatchesRegex?: RegExp[];
  /** Regex patterns the final assistant text must NOT match. */
  finalTextNotMatchesRegex?: RegExp[];
  /**
   * Ordering constraints on the tool-call trajectory. Each entry asserts
   * that the first occurrence of `before` appears at a strictly lower
   * index than the first occurrence of `after`. Both tools must appear —
   * pair with `toolsCalled` so that absence produces a clear failure
   * message rather than a silent ordering failure.
   *
   * Either side accepts an array, meaning "the earliest of any of these" —
   * for when the ordering is the assertion and the specific tool is not.
   * `{ before: ['edit_file', 'write_file'], after: 'run_tests' }` pins
   * verify-after-change without also deciding how the change was made; naming
   * one write tool there fails a model that legitimately took the other route.
   *
   * Examples:
   *   `{ before: 'read_file', after: 'edit_file' }` — pins read-before-write
   *   `{ before: ['edit_file','write_file'], after: 'run_tests' }` — verify-after-change
   *   `{ before: 'grep', after: 'edit_file' }` — pins search-before-edit
   */
  trajectoryOrder?: Array<{ before: string | string[]; after: string | string[] }>;
  /**
   * When `true`, at least one `tool_result` event in the trajectory
   * must have `isError === true`. Useful for cases that deliberately
   * give the agent a bad input and want to pin that the agent
   * observed the error at all (recovery assertions are separate —
   * use `toolsCalled` to assert it then tried a recovery tool).
   */
  trajectoryHasToolError?: boolean;
  /**
   * When `true`, at least one `thinking` event must appear in the
   * trajectory. Use this in `softExpect` for cases designed for
   * reasoning models (DeepSeek-R1, QwQ, Claude extended thinking) —
   * soft so non-thinking models still get evaluated on correctness
   * without failing on the presence check.
   */
  trajectoryHasThinking?: boolean;
  /**
   * When `true`, every file path cited in the final answer must resolve
   * against the post-run workspace (NodeNext `.js`->`.ts` fallback applied).
   * Measures the V1 unverified-claim gate's lift on review/analysis cases —
   * a fabricated citation that slips the gate fails here. (Roadmap M1.)
   */
  citationsResolve?: boolean;
}

/**
 * Per-case result produced by the agent harness + scorer. Mirrors
 * the shape of the prompt layer's CaseResult so the report renderer
 * can handle both with a common code path.
 */
export interface AgentCaseResult {
  id: string;
  description: string;
  passed: boolean;
  failures: string[];
  /** Failures from `softExpect` — reported but do not affect `passed`. */
  softFailures: string[];
  /** Every tool call + result + text emission the agent produced. */
  trajectory: TrajectoryEvent[];
  /** Final assistant text concatenated across turns. */
  finalText: string;
  /** The workspace contents after the run (for debugging regressions). */
  workspaceAfter: WorkspaceFixture;
  durationMs: number;
  iterationsUsed: number;
  /**
   * Graded per-run metrics (counts/rates), computed for every run regardless
   * of expectations. Verify-layer scaffolds can't show lift on binary
   * pass/fail (perfection-or-fail can't see a reduction — M1/M2 finding);
   * the ablation harness compares these as means across arms instead.
   * Currently: `unresolvedCitations` — cited paths that don't resolve.
   */
  metrics?: Record<string, number>;
  /**
   * True when the case timed out with no model output whatsoever (no text,
   * tool calls, or tool results). Indicates an API availability problem
   * (hanging connection, rate-limit queue, server overload) — NOT a model
   * behavioral regression. These cases are excluded from the pass/fail score
   * and shown with ⚠️ in the report.
   */
  apiUnavailable?: boolean;
}
