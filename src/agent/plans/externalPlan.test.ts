import { describe, it, expect } from 'vitest';
import { applyPlanUpdate, renderPlanState, MAX_PLAN_STEPS, MAX_STEP_CHARS } from './externalPlan.js';

describe('applyPlanUpdate', () => {
  it('accepts a full restatement with a current index', () => {
    const out = applyPlanUpdate({ steps: ['reproduce', 'locate', 'fix', 'verify'], current: 2 });
    expect(out).toEqual({ ok: true, plan: { steps: ['reproduce', 'locate', 'fix', 'verify'], current: 2 } });
  });

  it('defaults current to 1 when absent or invalid', () => {
    expect(applyPlanUpdate({ steps: ['a'] })).toMatchObject({ ok: true, plan: { current: 1 } });
    expect(applyPlanUpdate({ steps: ['a'], current: 'two' })).toMatchObject({ ok: true, plan: { current: 1 } });
  });

  it('clamps current into [1, steps.length] and rounds fractions', () => {
    expect(applyPlanUpdate({ steps: ['a', 'b'], current: 99 })).toMatchObject({ ok: true, plan: { current: 2 } });
    expect(applyPlanUpdate({ steps: ['a', 'b'], current: 0 })).toMatchObject({ ok: true, plan: { current: 1 } });
    expect(applyPlanUpdate({ steps: ['a', 'b'], current: 1.6 })).toMatchObject({ ok: true, plan: { current: 2 } });
  });

  it('captures last_result trimmed', () => {
    const out = applyPlanUpdate({ steps: ['a', 'b'], current: 2, last_result: '  bug found in x.ts  ' });
    expect(out).toMatchObject({ ok: true, plan: { lastResult: 'bug found in x.ts' } });
  });

  it('rejects missing, empty, or non-string steps with an actionable error', () => {
    expect(applyPlanUpdate({})).toMatchObject({ ok: false });
    expect(applyPlanUpdate({ steps: [] })).toMatchObject({ ok: false });
    expect(applyPlanUpdate({ steps: ['a', 42] })).toMatchObject({ ok: false });
    expect(applyPlanUpdate({ steps: ['a', '  '] })).toMatchObject({ ok: false });
  });

  it('rejects runaway plans and caps step text', () => {
    const tooMany = applyPlanUpdate({ steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => `s${i}`) });
    expect(tooMany).toMatchObject({ ok: false });
    const long = applyPlanUpdate({ steps: ['x'.repeat(MAX_STEP_CHARS + 50)] });
    expect(long.ok && long.plan.steps[0].length).toBe(MAX_STEP_CHARS);
  });
});

describe('renderPlanState', () => {
  it('renders current, last result, remaining, and compressed done lines', () => {
    const block = renderPlanState({
      steps: ['reproduce', 'locate', 'fix', 'verify'],
      current: 3,
      lastResult: 'bug is in parse()',
    });
    expect(block).toContain('<plan_state>');
    expect(block).toContain('Step 3/4 (current): fix');
    expect(block).toContain('Last result: bug is in parse()');
    expect(block).toContain('Remaining: 4. verify');
    expect(block).toContain('Done: 1. reproduce ✓ · 2. locate ✓');
    expect(block).toContain('</plan_state>');
  });

  it('omits empty sections on a fresh single-step plan', () => {
    const block = renderPlanState({ steps: ['do the thing'], current: 1 });
    expect(block).toContain('Step 1/1 (current): do the thing');
    expect(block).not.toContain('Remaining:');
    expect(block).not.toContain('Done:');
    expect(block).not.toContain('Last result:');
  });

  it('stays compact: a full 20-step plan renders under 2KB', () => {
    const block = renderPlanState({
      steps: Array.from({ length: 20 }, (_, i) => `step number ${i + 1} with some detail`),
      current: 10,
    });
    expect(block.length).toBeLessThan(2048);
  });
});
