import { buildBehavioralVerificationReprompt } from '../../completionGate.js';
import type { CompletionGate } from './types.js';

// Bounded re-fire: a model that games the gate with a hollow test gets told
// once more, then the gate stands down.
const MAX_INJECTIONS = 2;

/**
 * Behavioral-verification gate. Fires when the agent edited behavioral code but
 * ran no test that actually exercises it — including a HOLLOW test that never
 * imports the module under test (it asserts against an inline mock). A
 * lint/compile pass cannot catch a functional bug, so it reprompts for a real
 * test.
 *
 * DEFAULT OFF (`sidecar.behavioralVerificationGate.enabled`, default false).
 * Live SWE dogfooding showed this gate drives the same over-edit / spurious-test
 * thrash the adversarial critic did — net-negative on a local model (it pushes a
 * model that already produced a correct fix into writing extra, often broken,
 * test files). Kept as an independent toggle so its effect stays *measurable*,
 * but out of the default path until it earns its way back in via ablation.
 */
export const behavioralVerificationGate: CompletionGate = {
  name: 'behavioral-verification',
  enabled: (config) => config.behavioralVerificationGateEnabled === true,
  async maybeInject(state, ctx) {
    const { gateState, logger } = state;
    if ((gateState.behavioralVerificationInjections ?? 0) >= MAX_INJECTIONS) return 'skip';
    const reprompt = await buildBehavioralVerificationReprompt(
      gateState.currentUserRequest ?? '',
      gateState.editedFiles,
      {
        testsRunForFiles: gateState.testsRunForFiles,
        passingTestFiles: gateState.passingTestFiles,
        projectTestsPassed: gateState.projectTestsPassed,
      },
      undefined,
      state.lastFailureOutput,
    );
    if (!reprompt) return 'skip';
    gateState.behavioralVerificationInjections = (gateState.behavioralVerificationInjections ?? 0) + 1;
    logger?.info('Behavioral-verification gate fired — no test that actually exercises the edited behavior');
    ctx.callbacks.onText('\n\n🧪 Writing a test to confirm the fix actually works...\n');
    state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
    return 'injected';
  },
};
