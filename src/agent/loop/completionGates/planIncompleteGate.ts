import { planStepWriteTargetsNotWritten } from '../../plans/externalPlan.js';
import type { CompletionGate } from './types.js';

// A long plan legitimately needs more than one nudge, but an unbounded gate
// would loop a model that cannot comply.
const MAX_INJECTIONS = 2;

/**
 * Plan-incomplete gate. The one completion check with STRUCTURED evidence — no
 * prose matching: if an externalized plan exists and `current < steps.length`,
 * "all steps completed" is a deterministic contradiction (observed live:
 * llama3.2 declared completion at step 4/10 with 2 of 10 files written). Even at
 * `current == steps.length`, a step that NAMES a deliverable never written is a
 * provable false-completion claim (checked against editedFiles, no fs access).
 * Stands down when there is no plan. Its injection is PRIMARY work (the task
 * isn't done), so it latches `lastInjectionWasPrimaryWork` for the keep-best
 * ratchet.
 */
export const planIncompleteGate: CompletionGate = {
  name: 'plan-incomplete',
  enabled: (config) => config.completionGateEnabled !== false,
  async maybeInject(state, ctx) {
    const { gateState, logger } = state;
    const plan = state.planRef?.plan;
    const fired = gateState.planIncompleteInjections ?? 0;
    if (!plan || fired >= MAX_INJECTIONS) return 'skip';

    const incomplete = plan.current < plan.steps.length;
    const unwritten = incomplete ? [] : planStepWriteTargetsNotWritten(plan, gateState.editedFiles);
    if (!incomplete && unwritten.length === 0) return 'skip';

    gateState.planIncompleteInjections = fired + 1;
    gateState.lastInjectionWasPrimaryWork = true;
    const detail = incomplete
      ? `it shows step ${plan.current} of ${plan.steps.length}. Do not finish yet. Work the remaining steps in order:\n` +
        plan.steps
          .slice(plan.current - 1)
          .map((s, i) => `${plan.current + i}. ${s}`)
          .join('\n') +
        `\nWhen a step is done, include an update_plan call with the next current index alongside your next tool call — do not spend a message on update_plan alone. ` +
        `If the remaining steps are actually already finished, call update_plan with current=${plan.steps.length} before answering.`
      : `your plan says every step is done, but these files named in the plan were never written:\n` +
        unwritten.map((p) => `  - ${p}`).join('\n') +
        `\nCreate each with write_file(path, content) exactly as its plan step specifies, then answer.`;
    logger?.info(
      incomplete
        ? `Plan-incomplete gate fired — plan shows step ${plan.current}/${plan.steps.length}`
        : `Plan-incomplete gate fired — plan claims done but ${unwritten.length} named deliverable(s) unwritten`,
    );
    ctx.callbacks.onText(
      incomplete
        ? `\n\n📋 Plan shows step ${plan.current}/${plan.steps.length} — continuing remaining steps...\n`
        : `\n\n📋 Plan claims done but ${unwritten.length} planned file(s) missing — finishing them...\n`,
    );
    state.messages.push({
      role: 'user',
      content: [{ type: 'text' as const, text: `Your plan is not complete: ${detail}` }],
    });
    return 'injected';
  },
};
