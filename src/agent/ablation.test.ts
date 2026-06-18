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

describe('formatAblationReport', () => {
  it('renders a verdict per scaffold', () => {
    const report = formatAblationReport(
      summarizeAblation([run('completionGate', true, true, 2000), run('completionGate', false, false, 1000)]),
    );
    expect(report).toContain('completionGate');
    expect(report).toContain('HELPS');
  });

  it('handles an empty set', () => {
    expect(formatAblationReport([])).toBe('No ablation runs.');
  });
});
