import { MAX_GATE_INJECTIONS } from '../../../config/constants.js';
import { checkCompletionGate, buildGateInjection } from '../../completionGate.js';
import type { CompletionGate } from './types.js';

/**
 * The base completion gate: the original "you edited files but never verified
 * them" check. Runs LAST (after every specialized gate), and is the reason the
 * completion gate exists at all — it tracks which files were edited and which
 * verification commands ran, and refuses termination with unverified edits.
 *
 * Bounded to `maxGateInjections` per run (scaffolding-profile override, else
 * MAX_GATE_INJECTIONS) so a model that can't/won't verify isn't looped forever;
 * after the cap it logs a warning and allows termination.
 */
export const baseCompletionGate: CompletionGate = {
  name: 'completion',
  enabled: (config) => config.completionGateEnabled !== false,
  async maybeInject(state, ctx) {
    const { gateState, logger } = state;
    if (gateState.editedFiles.size === 0) return 'skip';

    const maxGateInjections = state.scaffoldingProfile?.maxGateInjections ?? MAX_GATE_INJECTIONS;
    if (gateState.gateInjections >= maxGateInjections) {
      logger?.warn(
        `Completion gate exhausted (${maxGateInjections} injections) — allowing termination with unverified edits`,
      );
      return 'skip';
    }

    const findings = await checkCompletionGate(gateState);
    if (findings.length === 0) return 'skip';

    gateState.gateInjections++;
    const injection = buildGateInjection(findings, gateState.gateInjections, maxGateInjections);
    logger?.info(
      `Completion gate fired (#${gateState.gateInjections}/${maxGateInjections}): ${findings.length} unverified edit(s)`,
    );
    ctx.callbacks.onText('\n\n🔒 Verifying changes before completion...\n');
    state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: injection }] });
    return 'injected';
  },
};
