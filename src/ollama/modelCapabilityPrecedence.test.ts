import { describe, it, expect, beforeEach } from 'vitest';
import { buildCapabilityProfile, setUserTierOverrides, getUserTierOverride } from './modelCapability.js';
import { summarizeModelPerformance, resetModelPerformanceForTests } from '../agent/modelPerformance.js';
import type { AgentRunMetrics } from '../agent/metrics.js';
import type { FailureBucket } from '../agent/failureTaxonomy.js';

// The precedence chain is the whole feature, and it is exactly the kind of thing
// that rots silently: add a branch in the wrong place and the user's explicit
// override starts losing to a heuristic, with no test failing.
//
//   user override → observed performance → tested baseline → name heuristic

function run(model: string, over: Partial<AgentRunMetrics> = {}): AgentRunMetrics {
  return {
    model,
    timestamp: 1,
    iterations: 3,
    toolCalls: [{ name: 'edit_file', durationMs: 5, isError: false }],
    totalTokensEstimate: 100,
    durationMs: 10,
    errors: [],
    costUsd: null,
    failureBucket: null,
    scaffoldInterventions: 0,
    aborted: false,
    ...over,
  };
}
const runs = (n: number, m: string, o: Partial<AgentRunMetrics> = {}) => Array.from({ length: n }, () => run(m, o));

beforeEach(() => {
  resetModelPerformanceForTests();
  setUserTierOverrides({});
});

describe('the name heuristic — the guess this feature exists to replace', () => {
  it('cannot tell SideCar’s best local model from its worst', () => {
    // Both of these are `weak` by parameter count alone. On the 5-case dogfood
    // suite one scores 5/5 and the other 2/5. A classifier that files the best
    // and worst local models in the same tier is not classifying anything — which
    // is why the baseline table and the learner exist.
    const byNameOnly = (m: string) => buildCapabilityProfile(m, { observed: null }).tier;
    expect(byNameOnly('some-unknown-model:7b')).toBe('weak');
    expect(byNameOnly('another-unknown:3b')).toBe('weak');
  });
});

describe('tested baseline beats the name heuristic', () => {
  it('qwen2.5-coder:7b is medium — measured, not inferred from "7b"', () => {
    const p = buildCapabilityProfile('qwen2.5-coder:7b');
    expect(p.tier).toBe('medium');
    expect(p.reasons.join(' ')).toMatch(/tested model/);
  });

  it('qwen3.5 is medium, though its name has no parseable size at all', () => {
    // The heuristic reads this as "unknown local model → conservative default".
    expect(buildCapabilityProfile('qwen3.5:latest').tier).toBe('medium');
  });

  it('llama3.2 stays weak — it earned that', () => {
    expect(buildCapabilityProfile('llama3.2:latest').tier).toBe('weak');
  });

  it('a quantized/instruct variant inherits its base model’s measurement', () => {
    expect(buildCapabilityProfile('qwen2.5-coder:7b-instruct-q4_K_M').tier).toBe('medium');
  });
});

describe('observed performance beats the baseline', () => {
  it('demotes a tested model that keeps failing HERE', () => {
    // The baseline says medium (5/5 on our repos). In this workspace it is
    // failing. The user's evidence wins over ours.
    const observed = summarizeModelPerformance(
      runs(5, 'qwen2.5-coder:7b', { failureBucket: 'wrong-tool' as FailureBucket }),
      'qwen2.5-coder:7b',
    );
    const p = buildCapabilityProfile('qwen2.5-coder:7b', { observed });
    expect(p.tier).toBe('weak');
    expect(p.reasons.join(' ')).toMatch(/more scaffolding/);
  });

  it('never promotes past a model that cannot call tools at all', () => {
    const observed = summarizeModelPerformance(runs(30, 'm'), 'm');
    const p = buildCapabilityProfile('m', { supportsTools: false, observed });
    expect(p.tier).toBe('weak');
  });
});

describe('user override beats everything, and is not second-guessed', () => {
  it('outranks the tested baseline', () => {
    setUserTierOverrides({ 'llama3.2': 'strong' });
    const p = buildCapabilityProfile('llama3.2:latest', { userTier: getUserTierOverride('llama3.2:latest') });
    expect(p.tier).toBe('strong');
    expect(p.reasons.join(' ')).toMatch(/user override/);
  });

  it('is NOT demoted by the learner, however badly the model performs', () => {
    // Detection can be wrong; the user has to be able to say so and have it stick.
    // A pinned tier that silently drifts back is not an override.
    const observed = summarizeModelPerformance(
      runs(20, 'llama3.2', { failureBucket: 'malformed-call' as FailureBucket, scaffoldInterventions: 5 }),
      'llama3.2',
    );
    setUserTierOverrides({ 'llama3.2': 'strong' });
    const p = buildCapabilityProfile('llama3.2', { observed, userTier: getUserTierOverride('llama3.2') });
    expect(p.tier).toBe('strong');
  });

  it('matches on prefix so a tag or quantization suffix still hits', () => {
    setUserTierOverrides({ 'qwen2.5-coder': 'weak' });
    expect(getUserTierOverride('qwen2.5-coder:7b-q8_0')).toBe('weak');
  });
});
