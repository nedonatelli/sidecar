// ---------------------------------------------------------------------------
// Model cost estimation.
//
// Two-layer lookup: a static table shipped in `src/config/modelCosts.json`
// covers well-known models (Claude, GPT-4, Gemini, …), and a runtime
// overlay is populated by provider catalogs at activation so an ingested
// OpenRouter pricing row (e.g. `anthropic/claude-sonnet-4.5`) takes
// precedence over the static table's substring match. Both layers store
// USD-per-1M-tokens so `estimateCost`'s arithmetic is uniform.
// ---------------------------------------------------------------------------

import modelCostsJson from '../modelCosts.json';

type ModelCostEntry = { input: number; output: number };

/** Static cost table from `src/config/modelCosts.json` — the fallback. */
const STATIC_MODEL_COSTS: Record<string, ModelCostEntry> = (
  modelCostsJson as { models: Record<string, ModelCostEntry> }
).models;

/**
 * Runtime overlay populated by provider catalogs (currently OpenRouter).
 * Keyed on the model id exactly as the provider returns it, so a full-
 * qualified lookup like `anthropic/claude-sonnet-4.5` hits this map
 * before falling through to the substring match against STATIC_MODEL_COSTS.
 *
 * Values are in USD per 1M tokens (same unit as the static table) so
 * `estimateCost`'s arithmetic works unchanged regardless of source.
 */
const RUNTIME_MODEL_COSTS = new Map<string, ModelCostEntry>();

const warnedUnknownModels = new Set<string>();

/**
 * Register a runtime cost entry from a provider catalog. Intended to be
 * called during extension activation (or whenever the catalog refreshes)
 * by code that just fetched per-model pricing from an upstream API.
 *
 * Input is already in USD-per-1M-tokens units. OpenRouter returns USD-
 * per-single-token strings, so the caller is responsible for the scale
 * conversion — see `ingestOpenRouterCatalog` below.
 */
export function registerModelCost(modelId: string, cost: ModelCostEntry): void {
  RUNTIME_MODEL_COSTS.set(modelId, cost);
  // A model that was previously unknown and warned about should not
  // keep suppressing warnings after pricing arrives — but conversely,
  // suddenly erroring about a now-known model would be silly. Simply
  // clear the warning so a future unknown lookup surfaces again if
  // needed.
  warnedUnknownModels.delete(modelId);
}

/**
 * Test-only: reset the once-per-model warning state.
 * Safe to call in production but no reason to.
 */
export function _resetUnknownModelWarnings(): void {
  warnedUnknownModels.clear();
}

/**
 * Test-only: drop every runtime-registered model cost.
 * Keeps tests isolated from each other when they exercise the overlay.
 */
export function _resetRuntimeModelCosts(): void {
  RUNTIME_MODEL_COSTS.clear();
}

/**
 * Ingest an OpenRouter `/v1/models` catalog payload into the runtime
 * cost overlay. OpenRouter returns pricing as decimal strings in USD
 * per single token (e.g. "0.000003" for $3/M), so we multiply by 1M
 * before storing to match the per-1M-token scale the rest of the code
 * uses. Entries with missing or malformed pricing are skipped silently.
 *
 * Returns the number of models successfully registered so the caller
 * can log a one-line summary on extension startup.
 */
export function ingestOpenRouterCatalog(
  models: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>,
): number {
  let registered = 0;
  for (const m of models) {
    const promptStr = m.pricing?.prompt;
    const completionStr = m.pricing?.completion;
    if (!promptStr || !completionStr) continue;
    const promptPerToken = Number.parseFloat(promptStr);
    const completionPerToken = Number.parseFloat(completionStr);
    if (!Number.isFinite(promptPerToken) || !Number.isFinite(completionPerToken)) continue;
    registerModelCost(m.id, {
      input: promptPerToken * 1_000_000,
      output: completionPerToken * 1_000_000,
    });
    registered++;
  }
  return registered;
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  // 1. Exact-id hit in the runtime overlay — OpenRouter-style
  //    `provider/model` ids live here after ingestOpenRouterCatalog.
  const runtime = RUNTIME_MODEL_COSTS.get(model);
  if (runtime) {
    return (inputTokens * runtime.input + outputTokens * runtime.output) / 1_000_000;
  }

  // 2. Substring match against the static table — catches
  //    `models/claude-sonnet-4-6` → `claude-sonnet-4-6` etc.
  const key = Object.keys(STATIC_MODEL_COSTS).find((k) => model.includes(k));
  if (key) {
    const costs = STATIC_MODEL_COSTS[key];
    return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
  }

  // 3. Unknown — warn once and return null.
  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    console.warn(
      `[SideCar cost] unknown model '${model}' — cost estimate unavailable. ` +
        `Add pricing to src/config/modelCosts.json or register it via an OpenRouter catalog ingest.`,
    );
  }
  return null;
}
