import { modelSupportsTools, getCachedOllamaNumCtx } from './ollamaBackend.js';
import { MODEL_CONTEXT_LENGTHS } from '../config/constants.js';
import { getModelBaseline } from '../agent/modelBaselines.js';
import {
  adjustTierByPerformance,
  getObservedPerformance,
  type ObservedPerformance,
} from '../agent/modelPerformance.js';

// ---------------------------------------------------------------------------
// Model capability profile (scaffolding roadmap A1).
//
// SideCar already tracks per-model signals — tool support, context window,
// eval pass rates — but they're scattered and mostly ephemeral, and there's no
// family detection or single profile. A1 consolidates them into one shape with
// a coarse `tier` that A2 reads to decide HOW MUCH scaffolding to apply to the
// one model the user is running (NOT which model to swap to — see the
// roadmap's single-model principle).
//
// Default is deliberately CONSERVATIVE: when we can't tell, assume weak →
// maximum scaffolding. For a local-first tool the cost of over-scaffolding a
// capable model is some latency; the cost of under-scaffolding a weak one is a
// wrong answer shipped with confidence.
//
// The pure functions (detectModelFamily / parseParamSizeB / buildCapability-
// Profile) have no I/O so they unit-test cleanly; resolveModelCapability is the
// thin adapter that reads the live in-memory signals.
// ---------------------------------------------------------------------------

export type ModelFamily =
  | 'claude'
  | 'gpt'
  | 'gemini'
  | 'qwen'
  | 'llama'
  | 'codellama'
  | 'gemma'
  | 'deepseek'
  | 'mistral'
  | 'phi'
  | 'unknown';

/** Frontier cloud families we treat as strong without further evidence. */
const FRONTIER_FAMILIES: ReadonlySet<ModelFamily> = new Set(['claude', 'gpt', 'gemini']);

export type CapabilityTier = 'weak' | 'medium' | 'strong';

export interface CapabilitySignals {
  /** Whether the model can reliably call tools (default: assume yes). */
  supportsTools?: boolean;
  /** Resolved context window in tokens, if known. */
  contextWindow?: number | null;
  /** Aggregate eval pass rate in [0,1], if eval data exists for this model. */
  evalPassRate?: number | null;
  /**
   * What this model has ACTUALLY done in this workspace. Outranks the baseline
   * and the heuristics below, because those are priors and this is measurement.
   * Null when the model has no track record yet (or learning is disabled).
   */
  observed?: ObservedPerformance | null;
  /**
   * An explicit tier from `sidecar.modelTier`. Absolute — detection can be
   * wrong, so the user gets the last word and nothing overrides them.
   */
  userTier?: CapabilityTier | null;
}

export interface ModelCapabilityProfile {
  model: string;
  family: ModelFamily;
  /** Parameter count in billions parsed from the model name, or null. */
  paramsB: number | null;
  supportsTools: boolean;
  contextWindow: number | null;
  evalPassRate: number | null;
  tier: CapabilityTier;
  /** Human-readable explanation of why this tier was assigned. */
  reasons: string[];
}

/** Detect the model family from its id. Order matters (codellama before llama). */
export function detectModelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (m.includes('claude') || m.includes('anthropic')) return 'claude';
  if (/\bgpt\b|gpt-|\bo[1-4]\b|^o[1-4]-/.test(m) || m.includes('openai')) return 'gpt';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('gemma')) return 'gemma';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('codellama') || m.includes('code-llama')) return 'codellama';
  if (m.includes('llama')) return 'llama';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('mistral') || m.includes('mixtral') || m.includes('codestral')) return 'mistral';
  if (m.includes('phi')) return 'phi';
  return 'unknown';
}

/** Parse a parameter count in billions from a model name (`:30b`, `-70b`, `0.5b`). */
export function parseParamSizeB(model: string): number | null {
  // Match the number immediately preceding a `b` size suffix, after a
  // separator so we don't catch arbitrary digits. Mixtral "8x7b" → 7 (the
  // per-expert size); good enough for tiering.
  const matches = [...model.toLowerCase().matchAll(/[:\-_ x](\d+(?:\.\d+)?)\s*b\b/g)];
  if (matches.length === 0) return null;
  // Take the largest match — handles names with multiple numbers.
  return Math.max(...matches.map((mm) => parseFloat(mm[1])));
}

/**
 * Build a capability profile from a model id + whatever live signals the caller
 * could gather. Pure: no I/O, fully testable.
 *
 * Precedence, strongest evidence first:
 *
 *   1. USER OVERRIDE  — the user said so. Absolute; detection can be wrong, and
 *                       they get the last word. Not second-guessed by the learner.
 *   2. OBSERVED       — what this model has actually done in this workspace.
 *                       Adjusts the baseline (see modelPerformance.ts).
 *   3. BASELINE       — what it scored on our test suites (modelBaselines.ts).
 *                       Measured, but on our repos — a prior, not a verdict.
 *   4. HEURISTIC      — a regex over the model's filename. The guess of last
 *                       resort, and the reason this whole chain exists: it reads
 *                       `qwen2.5-coder:7b` (5/5 on dogfood) and `llama3.2`
 *                       (2/5) as the same tier.
 */
export function buildCapabilityProfile(model: string, signals: CapabilitySignals = {}): ModelCapabilityProfile {
  const family = detectModelFamily(model);
  const paramsB = parseParamSizeB(model);
  const supportsTools = signals.supportsTools ?? true;
  const contextWindow = signals.contextWindow ?? null;
  const evalPassRate = signals.evalPassRate ?? null;
  const reasons: string[] = [];

  // 1. The user's word is final — no learning, no heuristics, no argument.
  if (signals.userTier) {
    reasons.push(`user override → ${signals.userTier}`);
    return { model, family, paramsB, supportsTools, contextWindow, evalPassRate, tier: signals.userTier, reasons };
  }

  // 3/4. Establish the baseline tier: measured if we have tested this model,
  // otherwise guessed from its name.
  const baseline = getModelBaseline(model);
  let tier: CapabilityTier;
  if (FRONTIER_FAMILIES.has(family)) {
    tier = 'strong';
    reasons.push(`frontier cloud family (${family})`);
  } else if (evalPassRate !== null) {
    // Eval data, when present, overrides heuristics — it's measured, not guessed.
    tier = evalPassRate >= 0.8 ? 'strong' : evalPassRate >= 0.5 ? 'medium' : 'weak';
    reasons.push(`eval pass rate ${(evalPassRate * 100).toFixed(0)}%`);
  } else if (baseline) {
    tier = baseline.tier;
    reasons.push(`tested model — ${baseline.evidence}`);
  } else if (supportsTools === false) {
    tier = 'weak';
    reasons.push('no reliable tool-call support');
  } else if (paramsB !== null) {
    tier = paramsB >= 30 ? 'medium' : 'weak';
    reasons.push(`${paramsB}B local model`);
  } else {
    // Unknown local model — default conservative (more scaffolding).
    tier = 'weak';
    reasons.push('unknown local model — conservative default');
  }

  // 2. Then let this workspace's own evidence move it. `supportsTools === false`
  // is a hard floor: a model that cannot call a tool is not promoted by anything.
  if (supportsTools !== false) {
    const decision = adjustTierByPerformance(tier, signals.observed ?? null);
    if (decision.reason) reasons.push(decision.reason);
    tier = decision.tier;
  }

  return { model, family, paramsB, supportsTools, contextWindow, evalPassRate, tier, reasons };
}

// ---------------------------------------------------------------------------
// User tier overrides (`sidecar.modelTier`).
//
// Every layer below this one — the learner, the baseline table, the name
// heuristic — can be wrong about a model, and the user is the one who has to
// live with it. So they get an absolute override, and nothing argues with it:
// a model pinned to `strong` is not quietly demoted after three bad runs.
//
// Held as module state, mirroring how `modelSupportsTools` and the cached
// context window already reach this file, so modelCapability stays free of any
// vscode import and stays a pure unit under test.
// ---------------------------------------------------------------------------

let userTierOverrides: Readonly<Record<string, CapabilityTier>> = {};

/** Install the user's `sidecar.modelTier` map. Called from settings on load and on change. */
export function setUserTierOverrides(overrides: Readonly<Record<string, CapabilityTier>>): void {
  userTierOverrides = overrides;
}

/** The user's explicit tier for `model`, or null. Exact match, then longest prefix. */
export function getUserTierOverride(model: string): CapabilityTier | null {
  const id = model.toLowerCase();
  const direct = userTierOverrides[id] ?? userTierOverrides[model];
  if (direct) return direct;

  let best: { key: string; tier: CapabilityTier } | null = null;
  for (const [key, tier] of Object.entries(userTierOverrides)) {
    const k = key.toLowerCase();
    if (!id.startsWith(k)) continue;
    if (!best || k.length > best.key.length) best = { key: k, tier };
  }
  return best?.tier ?? null;
}

/**
 * Resolve a profile for `model` from the live in-memory signals SideCar already
 * maintains: probed tool support, resolved context window, the user's explicit
 * tier override, and the model's observed track record in this workspace.
 *
 * Eval pass rate stays undefined here — most users have no eval data, and the
 * `modelBaselines` table now carries what our own eval runs measured.
 */
export function resolveModelCapability(model: string): ModelCapabilityProfile {
  const contextWindow = MODEL_CONTEXT_LENGTHS[model] ?? getCachedOllamaNumCtx(model) ?? null;
  return buildCapabilityProfile(model, {
    supportsTools: modelSupportsTools(model),
    contextWindow,
    observed: getObservedPerformance(model),
    userTier: getUserTierOverride(model),
  });
}
