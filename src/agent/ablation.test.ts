import { describe, it, expect } from 'vitest';
import { summarizeAblation, formatAblationReport, type AblationRun } from './ablation.js';

function run(scaffold: string, present: boolean, passed: boolean, durationMs: number, caseId = 'c'): AblationRun {
  return { scaffold, present, caseId, passed, durationMs };
}

describe('summarizeAblation', () => {
  it('computes lift and latency delta per scaffold', () => {
    const runs: AblationRun[] = [
      // gate present: 2/2 pass, ~2s; absent: 0/2 pass, ~1s → clear lift, costs ~1s
      run('completionGate', true, true, 2000),
      run('completionGate', true, true, 2000),
      run('completionGate', false, false, 1000),
      run('completionGate', false, false, 1000),
    ];
    const [s] = summarizeAblation(runs);
    expect(s.scaffold).toBe('completionGate');
    expect(s.passRateWith).toBe(1);
    expect(s.passRateWithout).toBe(0);
    expect(s.lift).toBe(1);
    expect(s.latencyDeltaMs).toBe(1000);
    expect(s.withN).toBe(2);
    expect(s.withoutN).toBe(2);
  });

  it('flags a scaffold with no lift but positive latency (pure tax)', () => {
    const runs: AblationRun[] = [run('analysisCritic', true, true, 5000), run('analysisCritic', false, true, 2000)];
    const [s] = summarizeAblation(runs);
    expect(s.lift).toBe(0);
    expect(s.latencyDeltaMs).toBe(3000);
  });

  it('sorts scaffolds by lift descending', () => {
    const runs: AblationRun[] = [
      run('weak', true, false, 100),
      run('weak', false, true, 100), // lift = -1
      run('strong', true, true, 100),
      run('strong', false, false, 100), // lift = +1
    ];
    expect(summarizeAblation(runs).map((s) => s.scaffold)).toEqual(['strong', 'weak']);
  });

  it('handles a scaffold present in only one arm without dividing by zero', () => {
    const [s] = summarizeAblation([run('x', true, true, 100)]);
    expect(s.passRateWith).toBe(1);
    expect(s.passRateWithout).toBe(0);
    expect(s.withoutN).toBe(0);
  });
});

describe('graded metrics (M1/M2 count/rate finding)', () => {
  function mRun(present: boolean, unresolvedCitations: number, passed = false): AblationRun {
    // passed=false in BOTH arms mirrors the real finding: the binary
    // citationsResolve scorer fails 100% either way, so lift is 0 and only
    // the graded metric can see the gate working.
    return {
      scaffold: 'citationGate',
      present,
      caseId: 'review',
      passed,
      durationMs: 1000,
      metrics: { unresolvedCitations },
    };
  }

  it('reports per-metric means across arms when binary lift is uncomputable', () => {
    const runs = [mRun(true, 0), mRun(true, 1), mRun(false, 2), mRun(false, 2)];
    const [s] = summarizeAblation(runs);
    expect(s.lift).toBe(0); // binary is blind…
    expect(s.metricDeltas).toEqual([
      { metric: 'unresolvedCitations', meanWith: 0.5, meanWithout: 2, delta: -1.5, withN: 2, withoutN: 2 },
    ]); // …the graded metric sees the reduction
  });

  it('ignores runs missing a metric instead of skewing the mean', () => {
    const legacy: AblationRun = { scaffold: 'citationGate', present: true, caseId: 'c', passed: true, durationMs: 1 };
    const runs = [mRun(true, 3), legacy, mRun(false, 3)];
    const [s] = summarizeAblation(runs);
    const d = s.metricDeltas[0];
    expect(d.meanWith).toBe(3);
    expect(d.withN).toBe(1);
    expect(d.withoutN).toBe(1);
  });

  it('produces no metric rows when no run carries metrics', () => {
    const runs = [run('completionGate', true, true, 1), run('completionGate', false, true, 1)];
    expect(summarizeAblation(runs)[0].metricDeltas).toEqual([]);
  });

  it('renders the reduction as without→with in the report', () => {
    const runs = [mRun(true, 0), mRun(true, 1), mRun(false, 2), mRun(false, 2)];
    const report = formatAblationReport(summarizeAblation(runs));
    expect(report).toContain('REDUCES');
    expect(report).toContain('unresolvedCitations 2.00→0.50 per run');
    expect(report).toContain('Δ -1.50');
  });
});

describe('formatAblationReport', () => {
  it('refuses to call ONE lucky pair a win — it reports NO POWER', () => {
    // This test used to assert HELPS here. One pair, scaffold passed, control
    // failed: a 50/50 coin landing heads once. The old rule was `lift > 0 → HELPS`,
    // which cannot tell that from a real effect — the same error as the SWE
    // campaign's n=1 "+100%". Significance on a single discordant pair is
    // arithmetically impossible (best p = 1.0).
    const report = formatAblationReport(
      summarizeAblation([run('completionGate', true, true, 2000), run('completionGate', false, false, 1000)]),
    );
    expect(report).toContain('completionGate');
    expect(report).toContain('NO POWER');
    expect(report).toContain('lift unmeasured');
    expect(report).not.toContain('HELPS');
  });

  it('calls HELPS once the discordant pairs actually support it', () => {
    // Six pairs the scaffold rescued and none it broke → exact McNemar p = 0.031.
    const runs = Array.from({ length: 6 }, (_, rep) => [
      { scaffold: 'completionGate', present: true, caseId: `c${rep}`, rep, passed: true, durationMs: 2000 },
      { scaffold: 'completionGate', present: false, caseId: `c${rep}`, rep, passed: false, durationMs: 1000 },
    ]).flat();

    const report = formatAblationReport(summarizeAblation(runs));
    expect(report).toContain('HELPS');
    expect(report).toContain('p=0.031');
    expect(report).toContain('disc=6/0');
  });

  it('handles an empty set', () => {
    expect(formatAblationReport([])).toBe('No ablation runs.');
  });
});
