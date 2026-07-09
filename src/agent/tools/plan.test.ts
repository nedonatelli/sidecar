import { describe, it, expect } from 'vitest';
import { planTools } from './plan.js';
import type { ToolExecutorContext } from './shared.js';
import type { ExternalPlan } from '../plans/externalPlan.js';

const updatePlan = planTools[0];

function ctx(planRef?: { plan: ExternalPlan | null }): ToolExecutorContext {
  return { planRef } as unknown as ToolExecutorContext;
}

describe('update_plan tool', () => {
  it('creates the plan on the shared ref and echoes the rendered state', async () => {
    const ref = { plan: null as ExternalPlan | null };
    const out = await updatePlan.executor({ steps: ['reproduce', 'fix', 'verify'], current: 1 }, ctx(ref));
    expect(ref.plan).toEqual({ steps: ['reproduce', 'fix', 'verify'], current: 1 });
    expect(out).toContain('Plan updated (3 steps, on step 1)');
    expect(out).toContain('<plan_state>');
  });

  it('advances the plan with a last_result on a later call', async () => {
    const ref = { plan: null as ExternalPlan | null };
    await updatePlan.executor({ steps: ['a', 'b'], current: 1 }, ctx(ref));
    await updatePlan.executor({ steps: ['a', 'b'], current: 2, last_result: 'a done' }, ctx(ref));
    expect(ref.plan).toEqual({ steps: ['a', 'b'], current: 2, lastResult: 'a done' });
  });

  it('returns an actionable error on invalid input without touching the ref', async () => {
    const ref = { plan: { steps: ['keep'], current: 1 } as ExternalPlan | null };
    const out = await updatePlan.executor({ steps: [] }, ctx(ref));
    expect(out).toContain('Error:');
    expect(ref.plan).toEqual({ steps: ['keep'], current: 1 });
  });

  it('errors politely when externalized planning is not active (no ref)', async () => {
    const out = await updatePlan.executor({ steps: ['a'] }, ctx(undefined));
    expect(out).toContain('sidecar.plan.externalized');
  });

  it('requires no approval (state-only, no side effects outside the loop)', () => {
    expect(updatePlan.requiresApproval).toBe(false);
  });
});
