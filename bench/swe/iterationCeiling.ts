// ---------------------------------------------------------------------------
// The iteration ceiling a SWE run uses: what the product would give this model.
//
// Since #237 the product's default ceiling depends on the model's tier (150
// strong, 50 otherwise), and the loop applies it only when the caller passes no
// ceiling. The driver always passed one (SIDECAR_SWE_MAX_ITERS ?? 50), so every
// strong-model SWE run measured 50 while the product shipped 150.
//
// The driver can't simply stop passing one, either. The loop resolves the tier
// default only with adaptive scaffolding on, and the scaffold-off arm turns it
// off, so strong models would get 150 in one arm and 50 in the other: every
// on/off lift would then be confounded with the iteration budget. So the
// driver resolves the shipped ceiling here, with the same functions the loop
// uses, and passes that one number to every arm.
// ---------------------------------------------------------------------------
import { resolveModelCapability, type CapabilityTier } from '../../src/ollama/modelCapability.js';
import { resolveScaffoldingProfile, type ScaffoldingOverrides } from '../../src/agent/scaffoldingProfile.js';

export interface IterationCeiling {
  maxIterations: number;
  /** 'env' for an explicit SIDECAR_SWE_MAX_ITERS, else the tier it came from. */
  source: 'env' | `tier:${CapabilityTier}`;
}

export function resolveIterationCeiling(
  model: string,
  envValue: string | undefined,
  overrides?: ScaffoldingOverrides,
): IterationCeiling {
  if (envValue !== undefined && envValue.trim() !== '') {
    const n = parseInt(envValue, 10);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`SIDECAR_SWE_MAX_ITERS must be a positive integer, got '${envValue}'`);
    return { maxIterations: n, source: 'env' };
  }
  const { tier } = resolveModelCapability(model);
  return { maxIterations: resolveScaffoldingProfile(tier, overrides).maxIterations, source: `tier:${tier}` };
}
