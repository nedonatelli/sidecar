import type { RegisteredTool } from './shared.js';
import { applyPlanUpdate, renderPlanState, MAX_PLAN_STEPS } from '../plans/externalPlan.js';

/**
 * `update_plan` — the model's handle on the externalized plan (S1). The loop
 * re-injects the current plan as a `<plan_state>` block every turn, so the
 * plan survives context compression and long-horizon drift. The tool
 * RESTATES the whole plan each call (simplest contract for a small model);
 * state mutation happens through `context.planRef`, which the loop owns.
 * Gated by `sidecar.plan.externalized`.
 */
export const planTools: RegisteredTool[] = [
  {
    definition: {
      name: 'update_plan',
      description:
        'Create or update your step-by-step plan for the current task. Call this FIRST on any multi-step task, ' +
        'and again each time you finish a step (advance `current`, report `last_result`). ' +
        'Always include it ALONGSIDE your next real tool call in the same message — never send a message that only updates the plan. ' +
        'The harness re-shows you the plan every turn, so it survives long tasks. Restate ALL steps every call. ' +
        `Example: update_plan(steps=["reproduce the bug","locate the cause","fix it","re-run tests"], current=1). Max ${MAX_PLAN_STEPS} steps.`,
      input_schema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'The COMPLETE ordered list of steps (restated in full every call).',
          },
          current: {
            type: 'number',
            description: '1-based index of the step you are working on now. Default 1.',
          },
          last_result: {
            type: 'string',
            description: 'One line: the outcome of the step you just finished (omit on the first call).',
          },
        },
        required: ['steps'],
      },
    },
    executor: async (input, context) => {
      const ref = context?.planRef;
      if (!ref) {
        return 'Error: externalized planning is not active for this run (sidecar.plan.externalized is off).';
      }
      const out = applyPlanUpdate(input);
      if (!out.ok) return `Error: ${out.error}`;
      ref.plan = out.plan;
      return `Plan updated (${out.plan.steps.length} steps, on step ${out.plan.current}).\n${renderPlanState(out.plan)}`;
    },
    requiresApproval: false,
  },
];
