// ---------------------------------------------------------------------------
// Per-tool budgets for a deliberate budget experiment (#268).
//
// SIDECAR_SWE_TOOL_BUDGETS=run_command=6,grep=6 lowers (or raises) those tools'
// per-session budgets for every arm alike. At the shipped budgets only about 3%
// of gemma4:e4b canary runs hit one (5 of 150 on 2026-10-21), too few to
// measure what a model does after a refusal; a lowered budget makes refusals
// common enough to compare. It goes through the product's own path
// (scaffolding.overrides.toolBudgets, applied per tool on top of the tier), and
// the manifest records it, so a run under it is never mistaken for a shipped one.
// ---------------------------------------------------------------------------
import type { ScaffoldingOverrides } from '../../src/agent/scaffoldingProfile.js';

/** Parse `tool=N,tool=N`. Undefined when unset or empty; throws on a malformed entry. */
export function parseToolBudgets(raw: string | undefined): Record<string, number> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const m = /^\s*([a-z_]+)\s*=\s*(\d+)\s*$/.exec(part);
    if (!m || Number(m[2]) < 1) {
      throw new Error(`SIDECAR_SWE_TOOL_BUDGETS: "${part.trim()}" is not tool=N with N >= 1`);
    }
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/** `overrides` with `budgets` applied per tool on top of any toolBudgets it already has. */
export function withToolBudgets(
  overrides: ScaffoldingOverrides | undefined,
  budgets: Record<string, number> | undefined,
): ScaffoldingOverrides | undefined {
  if (!budgets) return overrides;
  return { ...overrides, toolBudgets: { ...overrides?.toolBudgets, ...budgets } };
}
