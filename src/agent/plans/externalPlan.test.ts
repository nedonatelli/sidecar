import { describe, it, expect } from 'vitest';
import {
  applyPlanUpdate,
  planStepWriteTargetsNotWritten,
  advancePlanPastWrite,
  renderPlanState,
  parsePlanFromText,
  isPlanOnlyTurn,
  MAX_PLAN_STEPS,
  MAX_STEP_CHARS,
} from './externalPlan.js';

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

  it('renders the terminal footer when complete — never "work the current step" on a finished plan', () => {
    const block = renderPlanState({ steps: ['create a.md', 'create b.md'], current: 2 }, { complete: true });
    expect(block).toContain('All plan steps are complete');
    expect(block).toContain('final answer');
    expect(block).not.toContain('Work the current step');
  });

  it('keeps the working footer at current==len when NOT marked complete (last step still active)', () => {
    const block = renderPlanState({ steps: ['create a.md', 'create b.md'], current: 2 });
    expect(block).toContain('Work the current step');
  });

  it('stays compact: a full 20-step plan renders under 2KB', () => {
    const block = renderPlanState({
      steps: Array.from({ length: 20 }, (_, i) => `step number ${i + 1} with some detail`),
      current: 10,
    });
    expect(block.length).toBeLessThan(2048);
  });
});

describe('planStepWriteTargetsNotWritten (last-step false completion)', () => {
  const plan = {
    steps: [
      'Create out/f1.md containing exactly "k4q9-alpha"',
      'Read data/big.log and count the lines containing ERROR',
      'Create out/DONE.md containing exactly "sequence complete: jj90"',
    ],
    current: 3,
  };

  it('flags a write-intent deliverable that was never written', () => {
    expect(planStepWriteTargetsNotWritten(plan, new Set(['out/f1.md']))).toEqual(['out/DONE.md']);
  });

  it('returns empty when every named deliverable was written', () => {
    expect(planStepWriteTargetsNotWritten(plan, new Set(['out/f1.md', 'out/DONE.md']))).toEqual([]);
  });

  it('never flags read-only steps (input files are not deliverables)', () => {
    const missing = planStepWriteTargetsNotWritten(plan, new Set(['out/f1.md', 'out/DONE.md']));
    expect(missing).not.toContain('data/big.log');
  });

  it('normalizes windows separators in written paths', () => {
    expect(planStepWriteTargetsNotWritten(plan, new Set(['out\\f1.md', 'out\\DONE.md']))).toEqual([]);
  });
});

describe('advancePlanPastWrite (evidence-driven plan maintenance)', () => {
  const plan = {
    steps: [
      'Create out/f1.md containing exactly "k4q9-alpha"',
      'Create out/f2.md containing exactly "zw31-tango"',
      'Read data/big.log and count ERROR lines; write the number to out/errcount.md',
      'Create out/DONE.md containing exactly "sequence complete: jj90"',
    ],
    current: 1,
  };

  it('advances past the step whose deliverable was written', () => {
    expect(advancePlanPastWrite(plan, 'out/f1.md').current).toBe(2);
  });

  it('jumps forward when a later pending step completes out of order', () => {
    expect(advancePlanPastWrite(plan, 'out/errcount.md').current).toBe(4);
  });

  it('clamps at the last step and never rewinds', () => {
    expect(advancePlanPastWrite({ ...plan, current: 4 }, 'out/DONE.md').current).toBe(4);
    expect(advancePlanPastWrite({ ...plan, current: 3 }, 'out/f1.md').current).toBe(3);
  });

  it('ignores paths no write-verb step names', () => {
    expect(advancePlanPastWrite(plan, 'data/big.log')).toBe(plan); // read-only mention
    expect(advancePlanPastWrite(plan, 'src/other.ts')).toBe(plan);
  });

  it('normalizes windows separators', () => {
    expect(advancePlanPastWrite(plan, 'out\\f2.md').current).toBe(3);
  });
});

describe('isPlanOnlyTurn (iteration refund)', () => {
  it('is true only when every call in the turn is update_plan', () => {
    expect(isPlanOnlyTurn([{ name: 'update_plan' }])).toBe(true);
    expect(isPlanOnlyTurn([{ name: 'update_plan' }, { name: 'update_plan' }])).toBe(true);
    expect(isPlanOnlyTurn([{ name: 'update_plan' }, { name: 'write_file' }])).toBe(false);
    expect(isPlanOnlyTurn([{ name: 'write_file' }])).toBe(false);
    expect(isPlanOnlyTurn([])).toBe(false);
  });
});

describe('parsePlanFromText (harness-seeded creation)', () => {
  it('parses a numbered plan-mode plan', () => {
    const text = '# Plan\n\n1. Reproduce the bug\n2. Locate the cause\n3) Fix it\n4. Re-run the tests\n\nRisks: none.';
    expect(parsePlanFromText(text)).toEqual({
      steps: ['Reproduce the bug', 'Locate the cause', 'Fix it', 'Re-run the tests'],
      current: 1,
    });
  });

  it('parses bulleted plans and strips bold/checkbox noise', () => {
    const text = '- [ ] **Write the test**\n- Fix the parser\n* Verify';
    expect(parsePlanFromText(text)).toEqual({
      steps: ['Write the test', 'Fix the parser', 'Verify'],
      current: 1,
    });
  });

  it('returns null when fewer than 2 steps parse (prose, one-liners)', () => {
    expect(parsePlanFromText('I will simply fix the bug directly.')).toBeNull();
    expect(parsePlanFromText('1. Do the thing')).toBeNull();
  });

  it('caps at MAX_PLAN_STEPS', () => {
    const text = Array.from({ length: 30 }, (_, i) => `${i + 1}. step ${i + 1}`).join('\n');
    expect(parsePlanFromText(text)?.steps).toHaveLength(MAX_PLAN_STEPS);
  });
});
