// ---------------------------------------------------------------------------
// Externalized plan (scaffolding roadmap S1) — pure state + rendering.
//
// Long-horizon failure mode: the plan lives only in the drifting message
// window, so once compression fires (or the model wanders) the original
// decomposition is gone and the run devolves into local moves. S1 moves the
// plan OUT of the window into loop state the model updates via one tool
// (`update_plan`), and re-injects a compact `<plan_state>` block every turn:
// {current step, last result, remaining steps}. Re-injection makes the plan
// compaction-proof by construction — compression can never lose what the
// harness re-supplies.
//
// Deliberately minimal for weak models: the tool RESTATES the whole plan as
// strings plus a 1-based current index; statuses are DERIVED (before current
// = done, current = active, after = pending) so there is no per-step
// bookkeeping to get wrong. No VS Code imports — unit-testable and shared
// with the eval harness.
// ---------------------------------------------------------------------------

/** Hard caps so a runaway model can't blow up the per-turn injection. */
export const MAX_PLAN_STEPS = 20;
export const MAX_STEP_CHARS = 200;
export const MAX_RESULT_CHARS = 300;

export interface ExternalPlan {
  /** Ordered step descriptions, trimmed and capped. */
  steps: string[];
  /** 1-based index of the step currently being worked on. Clamped to steps. */
  current: number;
  /** One-line outcome of the most recently finished step, if reported. */
  lastResult?: string;
}

/** Outcome of applying an `update_plan` tool call. */
export type PlanUpdateOutcome = { ok: true; plan: ExternalPlan } | { ok: false; error: string };

/**
 * Validate and apply an `update_plan` tool input. Replaces the whole plan —
 * a full restatement is the simplest contract for a small model, and the
 * per-turn injection corrects any drift on the next turn anyway.
 */
export function applyPlanUpdate(input: Record<string, unknown>): PlanUpdateOutcome {
  const rawSteps = input.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { ok: false, error: "update_plan requires 'steps': a non-empty array of step descriptions." };
  }
  if (rawSteps.length > MAX_PLAN_STEPS) {
    return { ok: false, error: `update_plan supports at most ${MAX_PLAN_STEPS} steps — merge the small ones.` };
  }
  const steps: string[] = [];
  for (const s of rawSteps) {
    if (typeof s !== 'string' || s.trim() === '') {
      return { ok: false, error: "update_plan 'steps' must all be non-empty strings." };
    }
    steps.push(s.trim().slice(0, MAX_STEP_CHARS));
  }

  const rawCurrent = input.current;
  const current =
    typeof rawCurrent === 'number' && Number.isFinite(rawCurrent)
      ? Math.min(Math.max(Math.round(rawCurrent), 1), steps.length)
      : 1;

  const rawResult = input.last_result;
  const lastResult =
    typeof rawResult === 'string' && rawResult.trim() !== '' ? rawResult.trim().slice(0, MAX_RESULT_CHARS) : undefined;

  return { ok: true, plan: { steps, current, ...(lastResult ? { lastResult } : {}) } };
}

/**
 * Compact `<plan_state>` block appended to the system prompt each turn.
 * Shape follows the roadmap spec: current step, last result, remaining steps
 * — with done steps compressed to a single line so the injection stays small
 * on long plans (context economy).
 */
export function renderPlanState(plan: ExternalPlan): string {
  const lines: string[] = ['<plan_state>'];
  lines.push(`Step ${plan.current}/${plan.steps.length} (current): ${plan.steps[plan.current - 1]}`);
  if (plan.lastResult) lines.push(`Last result: ${plan.lastResult}`);
  const remaining = plan.steps.slice(plan.current).map((s, i) => `${plan.current + 1 + i}. ${s}`);
  if (remaining.length > 0) lines.push(`Remaining: ${remaining.join(' · ')}`);
  const done = plan.steps.slice(0, plan.current - 1).map((s, i) => `${i + 1}. ${s} ✓`);
  if (done.length > 0) lines.push(`Done: ${done.join(' · ')}`);
  // "in the SAME message" is load-bearing: granite followed the previous
  // wording ("when finished, call update_plan") to the letter and spent
  // whole turns on bookkeeping alone — 6 update_plan-only turns burned a
  // quarter of its iteration budget and it failed 9/10 at the cap.
  lines.push(
    'Work the current step. When you finish a step, include the update_plan call in the SAME message as your next real tool call — never spend a message on update_plan alone.',
  );
  lines.push('</plan_state>');
  return lines.join('\n');
}

/**
 * Parse an ExternalPlan from plan-mode output — the plan text the USER
 * approved, not arbitrary model prose. Extracts numbered ("1." / "1)") and
 * bulleted ("- " / "* ") lines; returns null when fewer than 2 steps parse
 * (a one-liner needs no external plan). This is the harness-seeded creation
 * path: five model families produced zero voluntary update_plan calls, so
 * plan creation cannot depend on model initiative.
 */
export function parsePlanFromText(text: string): ExternalPlan | null {
  const steps: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(?:\d{1,2}[.)]|[-*])\s+(.+\S)\s*$/.exec(line);
    if (!m) continue;
    // Strip markdown bold/checkbox noise from the step text.
    const step = m[1]
      .replace(/^\[[ x]\]\s*/i, '')
      .replace(/\*\*/g, '')
      .trim();
    if (step) steps.push(step.slice(0, MAX_STEP_CHARS));
    if (steps.length === MAX_PLAN_STEPS) break;
  }
  if (steps.length < 2) return null;
  return { steps, current: 1 };
}
