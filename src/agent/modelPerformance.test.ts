import { describe, it, expect, beforeEach } from 'vitest';
import {
  summarizeModelPerformance,
  adjustTierByPerformance,
  hydrateModelPerformance,
  getObservedPerformance,
  setModelLearningEnabled,
  recordRunForLearning,
  resetModelPerformanceForTests,
  MIN_RUNS_TO_PROMOTE,
} from './modelPerformance.js';
import type { AgentRunMetrics } from './metrics.js';
import type { FailureBucket } from './failureTaxonomy.js';

/** A run of `model`. Defaults to a clean agentic success that never needed the scaffolding. */
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

const runs = (n: number, model: string, over: Partial<AgentRunMetrics> = {}) =>
  Array.from({ length: n }, () => run(model, over));

beforeEach(() => resetModelPerformanceForTests());

describe('summarizeModelPerformance — what counts as evidence', () => {
  it('ignores runs from other models', () => {
    const obs = summarizeModelPerformance([run('a'), run('b'), run('b')], 'b');
    expect(obs?.runs).toBe(2);
  });

  it('discards ABORTED runs rather than scoring them as successes', () => {
    // classifyFailureBucket maps an abort to `null` (not the model's fault),
    // which is right for the taxonomy and poison as evidence: counting it would
    // score every time the user pressed Stop as proof of competence.
    const obs = summarizeModelPerformance([run('m'), run('m', { aborted: true, failureBucket: null })], 'm');
    expect(obs?.runs).toBe(1);
  });

  it('discards NON-AGENTIC runs — answering a question proves nothing about editing code', () => {
    const obs = summarizeModelPerformance([run('m'), run('m', { toolCalls: [] })], 'm');
    expect(obs?.runs).toBe(1);
  });

  it('returns null with no evidence at all, rather than inventing a rate', () => {
    expect(summarizeModelPerformance([], 'm')).toBeNull();
    expect(summarizeModelPerformance([run('other')], 'm')).toBeNull();
  });

  it('computes success and intervention rates separately', () => {
    const sample = [
      run('m'), // clean success
      run('m', { scaffoldInterventions: 2 }), // succeeded, but needed help
      run('m', { failureBucket: 'wrong-tool' as FailureBucket, scaffoldInterventions: 1 }),
    ];
    const obs = summarizeModelPerformance(sample, 'm')!;
    expect(obs.successRate).toBeCloseTo(2 / 3);
    expect(obs.interventionRate).toBeCloseTo(2 / 3);
  });
});

describe('adjustTierByPerformance — demotion is cheap, promotion is not', () => {
  it('demotes a failing model on only a few runs — adding scaffolding is the safe move', () => {
    const obs = summarizeModelPerformance(runs(4, 'm', { failureBucket: 'wrong-tool' as FailureBucket }), 'm');
    const d = adjustTierByPerformance('medium', obs);
    expect(d.tier).toBe('weak');
    expect(d.adjusted).toBe(true);
  });

  it('does NOT promote a model that succeeds only BECAUSE the scaffolding keeps saving it', () => {
    // The circularity this whole design exists to avoid. qwen2.5-coder passes the
    // add-jsdoc dogfood case at 100% — but only because the action reprompt drags
    // it back to work after it narrates the edit instead of making it. Promote on
    // success alone and you strip the guard that produced the success.
    const perfect = runs(20, 'm', { failureBucket: null, scaffoldInterventions: 1 });
    const obs = summarizeModelPerformance(perfect, 'm')!;
    expect(obs.successRate).toBe(1); // flawless...
    expect(obs.interventionRate).toBe(1); // ...and leaning on the scaffolding every single run

    const d = adjustTierByPerformance('weak', obs);
    expect(d.tier).toBe('weak');
    expect(d.adjusted).toBe(false);
    expect(d.reason).toMatch(/scaffolding still firing/);
  });

  it('promotes a model that succeeds WITHOUT ever reaching for the safety net', () => {
    const obs = summarizeModelPerformance(runs(MIN_RUNS_TO_PROMOTE, 'm', { scaffoldInterventions: 0 }), 'm');
    const d = adjustTierByPerformance('weak', obs);
    expect(d.tier).toBe('medium');
    expect(d.adjusted).toBe(true);
  });

  it('will not promote on a small sample, however clean', () => {
    const obs = summarizeModelPerformance(runs(MIN_RUNS_TO_PROMOTE - 1, 'm'), 'm');
    expect(adjustTierByPerformance('weak', obs).tier).toBe('weak');
  });

  it('moves one step at a time — never weak straight to strong', () => {
    const obs = summarizeModelPerformance(runs(50, 'm'), 'm');
    expect(adjustTierByPerformance('weak', obs).tier).toBe('medium');
  });

  it('keeps the baseline tier when there is no evidence', () => {
    const d = adjustTierByPerformance('medium', null);
    expect(d).toEqual({ tier: 'medium', reason: '', adjusted: false });
  });

  it('clamps at the ends instead of walking off the tier list', () => {
    const failing = summarizeModelPerformance(runs(5, 'm', { failureBucket: 'timeout' as FailureBucket }), 'm');
    expect(adjustTierByPerformance('weak', failing).tier).toBe('weak');

    const clean = summarizeModelPerformance(runs(20, 'm'), 'm');
    expect(adjustTierByPerformance('strong', clean).tier).toBe('strong');
  });
});

describe('live signal registry', () => {
  it('hydrates from persisted history and folds in new runs', () => {
    hydrateModelPerformance(runs(3, 'm'));
    expect(getObservedPerformance('m')?.runs).toBe(3);

    recordRunForLearning(run('m'));
    expect(getObservedPerformance('m')?.runs).toBe(4);
  });

  it('goes silent when learning is disabled — tiers fall back to their baseline', () => {
    hydrateModelPerformance(runs(20, 'm'));
    setModelLearningEnabled(false);
    expect(getObservedPerformance('m')).toBeNull();
  });
});
