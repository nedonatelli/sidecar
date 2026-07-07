import { describe, it, expect } from 'vitest';
import { classifyBfclFailure, failureAxis, summarizeFailures, formatFailureAxes } from './failureClassifier.js';

// Reason strings are taken VERBATIM from astChecker.ts so the classifier stays
// in lockstep with the checker that produces them.
describe('classifyBfclFailure — maps real checker reasons', () => {
  const cases: Array<[string, string, string]> = [
    ['expected function "get_weather", got "set_weather"', 'wrong-function', 'selection'],
    ['function "frobnicate" is not in the provided schema', 'hallucinated-function', 'selection'],
    ['expected no function call, got get_weather', 'spurious-call', 'selection'],
    ['expected at least one function call, got none', 'missing-call', 'selection'],
    ['expected exactly 1 call, got 2', 'wrong-call-count', 'structure'],
    ['expected 3 calls, got 2', 'wrong-call-count', 'structure'],
    ['missing required parameter "location"', 'missing-argument', 'argument'],
    ['missing parameter "unit"', 'missing-argument', 'argument'],
    ['hallucinated parameter "foo" (not in schema)', 'extra-argument', 'argument'],
    ['parameter "unit" = "kelvin" not in acceptable set', 'wrong-argument-value', 'argument'],
    ['no call satisfied expected "get_weather"', 'no-parallel-match', 'structure'],
    ['case has no ground truth', 'other', 'structure'],
  ];

  it('classifies each reason into the right type + axis', () => {
    for (const [reason, type, axis] of cases) {
      expect(classifyBfclFailure(reason), reason).toBe(type);
      expect(failureAxis(classifyBfclFailure(reason)), reason).toBe(axis);
    }
  });

  it('hallucinated-function wins over wrong-function when both could match', () => {
    // The "not in schema" check runs before the name check in the checker.
    expect(classifyBfclFailure('function "x" is not in the provided schema')).toBe('hallucinated-function');
  });
});

describe('summarizeFailures + formatFailureAxes', () => {
  it('aggregates by type and axis — the selection-vs-argument split', () => {
    const d = summarizeFailures([
      'expected function "a", got "b"', // selection
      'function "z" is not in the provided schema', // selection
      'parameter "p" = 1 not in acceptable set', // argument
      'missing required parameter "q"', // argument
      'expected exactly 1 call, got 2', // structure
    ]);
    expect(d.total).toBe(5);
    expect(d.byAxis).toEqual({ selection: 2, argument: 2, structure: 1 });
    expect(d.byType['wrong-function']).toBe(1);
    expect(d.byType['wrong-argument-value']).toBe(1);
  });

  it('formats a readable selection/argument/structure line', () => {
    const d = summarizeFailures(['expected function "a", got "b"', 'parameter "p" = 1 not in acceptable set']);
    const s = formatFailureAxes(d);
    expect(s).toContain('selection 1 (50%)');
    expect(s).toContain('argument 1 (50%)');
  });

  it('handles the empty case', () => {
    expect(formatFailureAxes(summarizeFailures([]))).toBe('no failures to classify');
  });
});
