// ---------------------------------------------------------------------------
// BFCL v4 (Berkeley Function Calling Leaderboard) — data model.
//
// This adapter implements the AST-evaluated, non-executable subset of BFCL:
// the categories that score the model's emitted function call(s) against a set
// of acceptable answers via abstract-syntax matching, with no live API calls.
// That subset is the part relevant to SideCar's model-selection question — "is
// this local model's function-calling competitive in its weight class?" — and
// runs offline with no Docker.
//
// See bench/bfcl/README.md for the categories we cover, the simplifications vs.
// upstream BFCL's checker, and how to drop in the full dataset.
// ---------------------------------------------------------------------------

/** AST-evaluated BFCL categories this adapter scores. Executable + multi-turn
 *  agentic categories are out of scope for Phase 1 (they need a live API server
 *  / stateful backend). */
export type BfclCategory =
  /** One function provided, one call expected. */
  | 'simple'
  /** Several functions provided, the model must pick the right one (one call). */
  | 'multiple'
  /** One function, multiple calls expected in a single response. */
  | 'parallel'
  /** Several functions, multiple calls expected. */
  | 'parallel_multiple'
  /** Functions provided but none applies — the model must NOT call anything. */
  | 'irrelevance'
  /** A relevant function exists — the model must emit at least one call. */
  | 'relevance';

/** A JSON-schema-ish parameter spec as BFCL ships them. `type` uses BFCL's
 *  vocabulary (`integer`, `float`, `dict`, `tuple`, `array`, `any`, …). */
export interface BfclParamSchema {
  type: string;
  description?: string;
  items?: BfclParamSchema;
  properties?: Record<string, BfclParamSchema>;
  enum?: unknown[];
}

export interface BfclFunctionSchema {
  name: string;
  description?: string;
  parameters: {
    type: string;
    properties: Record<string, BfclParamSchema>;
    required?: string[];
  };
}

/**
 * One acceptable answer. Keyed by function name; each parameter maps to a list
 * of acceptable values (BFCL encodes "this param may be any of these"). An
 * optional parameter the model is allowed to omit carries `""` in its list.
 */
export type GroundTruthEntry = Record<string, Record<string, unknown[]>>;

export interface BfclCase {
  id: string;
  category: BfclCategory;
  /** Flattened single-turn user prompt. */
  question: string;
  /** Function schemas offered to the model for this case. */
  functions: BfclFunctionSchema[];
  /**
   * Acceptable answers. For `parallel*` there is one entry per expected call;
   * for `simple`/`multiple` exactly one entry. Absent for `irrelevance`
   * (success = no call) and `relevance` (success = any call).
   */
  groundTruth?: GroundTruthEntry[];
}

/** A function call parsed out of a model response, normalized across backends. */
export interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ScoreResult {
  pass: boolean;
  /** Human-readable reason a case failed (empty on pass). */
  reason: string;
}

export interface CaseOutcome extends ScoreResult {
  id: string;
  category: BfclCategory;
}

export interface CategoryReport {
  category: BfclCategory;
  passed: number;
  total: number;
  /** passed / total in [0,1]; 1 when total is 0. */
  accuracy: number;
}

export interface BfclReport {
  /** Per-category accuracy. */
  categories: CategoryReport[];
  /** Unweighted mean of per-category accuracy (NOT BFCL's official weighted
   *  overall — see README). */
  macroAccuracy: number;
  /** Flat pass/total across all cases. */
  microAccuracy: number;
  passed: number;
  total: number;
  /** Every failing case, for drill-down. */
  failures: CaseOutcome[];
}
