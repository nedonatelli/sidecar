// ---------------------------------------------------------------------------
// BFCL AST checker — the scoring core.
//
// Given the model's emitted function call(s) and a case's acceptable answers,
// decide pass/fail by abstract-syntax matching: right function name, required
// params present, no hallucinated params, and each parameter value within the
// case's acceptable set (type-aware). This is the part that must be provably
// correct, so it is pure (no I/O) and exhaustively unit-tested.
//
// Faithful-but-pragmatic vs. upstream BFCL's Python checker. We implement: name
// match, required-present, no-extra-params, value-in-acceptable-set with
// numeric/boolean coercion, order-sensitive array equality, and recursive dict
// equality. We deliberately DO NOT implement BFCL's unit normalization or fuzzy
// string canonicalization — see bench/bfcl/README.md "Simplifications".
// ---------------------------------------------------------------------------

import type { BfclCase, BfclCategory, BfclFunctionSchema, GroundTruthEntry, ParsedCall, ScoreResult } from './types.js';

const PASS: ScoreResult = { pass: true, reason: '' };
const fail = (reason: string): ScoreResult => ({ pass: false, reason });

/** Sentinel an optional parameter's acceptable list carries when the model is
 *  allowed to omit it. */
const OMITTABLE = '';

export function checkCase(c: BfclCase, calls: ParsedCall[]): ScoreResult {
  switch (c.category) {
    case 'relevance':
      // A relevant function exists — the model must act.
      return calls.length >= 1 ? PASS : fail('expected at least one function call, got none');
    case 'irrelevance':
      // Nothing applies — emitting any call is a hallucination.
      return calls.length === 0 ? PASS : fail(`expected no function call, got ${calls.map((x) => x.name).join(', ')}`);
    case 'simple':
    case 'multiple': {
      if (calls.length !== 1) return fail(`expected exactly 1 call, got ${calls.length}`);
      const gt = c.groundTruth?.[0];
      if (!gt) return fail('case has no ground truth');
      return checkSingle(calls[0], gt, c.functions);
    }
    case 'parallel':
    case 'parallel_multiple':
      return checkParallel(calls, c.groundTruth ?? [], c.functions);
    default:
      return fail(`unsupported category: ${c.category as string}`);
  }
}

/**
 * Match a set of calls against a set of acceptable answers as a bijection:
 * counts must be equal and every ground-truth entry must be satisfied by a
 * distinct call. Order-independent (parallel calls may arrive in any order).
 */
function checkParallel(
  calls: ParsedCall[],
  groundTruth: GroundTruthEntry[],
  functions: BfclFunctionSchema[],
): ScoreResult {
  if (calls.length !== groundTruth.length) {
    return fail(`expected ${groundTruth.length} calls, got ${calls.length}`);
  }
  const used = new Array<boolean>(calls.length).fill(false);
  for (const gt of groundTruth) {
    let matchedIdx = -1;
    for (let i = 0; i < calls.length; i++) {
      if (used[i]) continue;
      if (checkSingle(calls[i], gt, functions).pass) {
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx === -1) {
      const want = Object.keys(gt)[0];
      return fail(`no call satisfied expected "${want}"`);
    }
    used[matchedIdx] = true;
  }
  return PASS;
}

/** Check one call against one acceptable answer + the function schema. */
function checkSingle(call: ParsedCall, gt: GroundTruthEntry, functions: BfclFunctionSchema[]): ScoreResult {
  const expectedName = Object.keys(gt)[0];
  if (call.name !== expectedName) {
    return fail(`expected function "${expectedName}", got "${call.name}"`);
  }

  const schema = functions.find((f) => f.name === call.name);
  if (!schema) return fail(`function "${call.name}" is not in the provided schema`);

  const props = schema.parameters.properties ?? {};
  const required = schema.parameters.required ?? [];

  // Required params must be present.
  for (const r of required) {
    if (!(r in call.args)) return fail(`missing required parameter "${r}"`);
  }

  // No hallucinated params.
  for (const k of Object.keys(call.args)) {
    if (!(k in props)) return fail(`hallucinated parameter "${k}" (not in schema)`);
  }

  // Every ground-truth-constrained param must match.
  const want = gt[expectedName];
  for (const [param, acceptable] of Object.entries(want)) {
    const present = param in call.args;
    if (!present) {
      if (acceptable.some((a) => a === OMITTABLE)) continue; // optional, validly omitted
      return fail(`missing parameter "${param}"`);
    }
    if (!acceptable.some((a) => valueEquals(call.args[param], a))) {
      return fail(`parameter "${param}" = ${jsonish(call.args[param])} not in acceptable set`);
    }
  }

  return PASS;
}

/**
 * Type-aware equality between a model-emitted value and an acceptable value.
 * Coercions: numeric strings ↔ numbers, "true"/"false" ↔ booleans. Arrays are
 * order-sensitive and length-checked; objects compared recursively by key.
 */
export function valueEquals(got: unknown, want: unknown): boolean {
  if (got === want) return true;

  // null / undefined collapse together.
  if (got == null && want == null) return true;
  if (got == null || want == null) return false;

  // Numbers (with numeric-string coercion): 5 === 5.0 === "5".
  const gn = asNumber(got);
  const wn = asNumber(want);
  if (gn !== null && wn !== null) return gn === wn;

  // Booleans (with string coercion).
  const gb = asBool(got);
  const wb = asBool(want);
  if (gb !== null && wb !== null) return gb === wb;

  // Arrays: order-sensitive element equality.
  if (Array.isArray(got) && Array.isArray(want)) {
    if (got.length !== want.length) return false;
    return got.every((g, i) => valueEquals(g, want[i]));
  }
  if (Array.isArray(got) || Array.isArray(want)) return false;

  // Plain objects: same keys, recursively equal values.
  if (isObject(got) && isObject(want)) {
    const gk = Object.keys(got);
    const wk = Object.keys(want);
    if (gk.length !== wk.length) return false;
    return gk.every((k) => k in want && valueEquals(got[k], (want as Record<string, unknown>)[k]));
  }

  // Strings: exact after trimming (no unit/fuzzy normalization — see README).
  if (typeof got === 'string' && typeof want === 'string') {
    return got.trim() === want.trim();
  }

  return false;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonish(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Re-exported so callers can reference the category set without importing types. */
export const AST_CATEGORIES: readonly BfclCategory[] = [
  'simple',
  'multiple',
  'parallel',
  'parallel_multiple',
  'irrelevance',
  'relevance',
];
