// Push the user's model-learning settings into the two module-level registries
// that back the capability profile.
//
// Lives in its own file to keep the dependency graph acyclic: `modelCapability`
// already imports `modelPerformance` (to adjust a tier by observed performance),
// so `modelPerformance` cannot import back from `modelCapability` to install the
// tier overrides. This module depends on both and is depended on by neither.

import type { SideCarConfig } from '../config/settings.js';
import { setUserTierOverrides } from '../ollama/modelCapability.js';
import { setModelLearningEnabled } from './modelPerformance.js';

/** Apply `sidecar.modelLearning.enabled` and `sidecar.modelTier` to the live registries. */
export function applyModelLearningSettings(
  config: Pick<SideCarConfig, 'modelLearningEnabled' | 'modelTierOverrides'>,
): void {
  setModelLearningEnabled(config.modelLearningEnabled);
  setUserTierOverrides(config.modelTierOverrides ?? {});
}
