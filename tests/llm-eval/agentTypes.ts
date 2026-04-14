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
   * Agent loop options. Defaults: approvalMode='autonomous',
   * maxIterations=8 (eval cases should be focused — runaway loops
   * almost always mean the case is wrong or the model regressed).
   */
  approvalMode?: 'autonomous' | 'cautious' | 'manual' | 'plan' | 'review';
  maxIterations?: number;
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
  /** Tool names that must NOT appear in the trajectory (e.g. no write tools for a read-only case). */
  toolsNotCalled?: string[];
  /**
   * Specific tool-call+input pairs that must appear. Input is a
   * partial match — the recorded call's input must contain every
   * key/value in the expected object, but may have additional keys.
   */
  toolCallMatches?: Array<{ name: string; inputPartial: Record<string, unknown> }>;
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
    /** File's content, after the run, must exactly equal the expected string. */
    equal?: Array<{ path: string; content: string }>;
  };
  /** Assistant final-text predicates (case-insensitive substring). */
  finalTextContains?: string[];
  finalTextNotContains?: string[];
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
  /** Every tool call + result + text emission the agent produced. */
  trajectory: TrajectoryEvent[];
  /** Final assistant text concatenated across turns. */
  finalText: string;
  /** The workspace contents after the run (for debugging regressions). */
  workspaceAfter: WorkspaceFixture;
  durationMs: number;
  iterationsUsed: number;
}
