import { modelSupportsTools, getCachedOllamaNumCtx } from './ollamaBackend.js';
import { MODEL_CONTEXT_LENGTHS } from '../config/constants.js';

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
 * Build a capability profile from a model id + whatever live signals the
 * caller could gather. Pure: no I/O, fully testable.
 */
export function buildCapabilityProfile(model: string, signals: CapabilitySignals = {}): ModelCapabilityProfile {
  const family = detectModelFamily(model);
  const paramsB = parseParamSizeB(model);
  const supportsTools = signals.supportsTools ?? true;
  const contextWindow = signals.contextWindow ?? null;
  const evalPassRate = signals.evalPassRate ?? null;
  const reasons: string[] = [];

  let tier: CapabilityTier;
  if (FRONTIER_FAMILIES.has(family)) {
    tier = 'strong';
    reasons.push(`frontier cloud family (${family})`);
  } else if (evalPassRate !== null) {
    // Eval data, when present, overrides heuristics — it's measured, not guessed.
    tier = evalPassRate >= 0.8 ? 'strong' : evalPassRate >= 0.5 ? 'medium' : 'weak';
    reasons.push(`eval pass rate ${(evalPassRate * 100).toFixed(0)}%`);
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

  return { model, family, paramsB, supportsTools, contextWindow, evalPassRate, tier, reasons };
}

/**
 * Resolve a profile for `model` from the live in-memory signals SideCar
 * already maintains: probed tool support + resolved context window. Eval pass
 * rate is left undefined here (most users have no eval data); A2 wires the
 * HistoryDb baseline read when it's available.
 */
export function resolveModelCapability(model: string): ModelCapabilityProfile {
  const contextWindow = MODEL_CONTEXT_LENGTHS[model] ?? getCachedOllamaNumCtx(model) ?? null;
  return buildCapabilityProfile(model, {
    supportsTools: modelSupportsTools(model),
    contextWindow,
  });
}
