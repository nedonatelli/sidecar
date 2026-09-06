import type { CompletionGate } from './types.js';

// Fires at most twice; the wording explicitly allows an honest could-not-complete
// report to exit, so a model in an unfixable workspace is not trapped.
const MAX_INJECTIONS = 2;

/**
 * Red-check gate: the model's own verification FAILED and it's trying to finish
 * anyway. The completion gate historically verified that checks RAN, not that
 * they PASSED — v0.122 gemma4 ran `tsc --noEmit`, saw the errors, wrote "this is
 * expected, the compiler hasn't picked up the change," and finished with a
 * broken import. This gate refuses completion while the last check is red. The
 * fix work it demands is PRIMARY work (the task isn't done while its check
 * fails), so it latches `lastInjectionWasPrimaryWork` for the keep-best ratchet.
 *
 * Own flag `sidecar.redCheckGate.enabled` (default on with the completion gate):
 * this is the verification-forcing lever most likely to rescue a wrong-but-
 * plausible patch — and the one most likely to trigger over-editing — so it is
 * independently toggleable for ablation.
 */
export const redCheckGate: CompletionGate = {
  name: 'red-check',
  enabled: (config) => config.completionGateEnabled !== false && config.redCheckGateEnabled !== false,
  async maybeInject(state, ctx) {
    const { gateState, logger } = state;
    if (!gateState.failedCheckOutput || (gateState.redCheckInjections ?? 0) >= MAX_INJECTIONS) return 'skip';

    gateState.redCheckInjections = (gateState.redCheckInjections ?? 0) + 1;
    gateState.lastInjectionWasPrimaryWork = true;
    const attempt = gateState.redCheckInjections;
    logger?.info(`Red-check gate fired (attempt ${attempt}/${MAX_INJECTIONS}) — last verification FAILED`);
    ctx.callbacks.onText(
      '\n\n🔴 The last check FAILED — completion refused until it passes or the failure is reported.\n',
    );
    state.messages.push({
      role: 'user',
      content: [
        {
          type: 'text' as const,
          text:
            `[Completion gate] The last verification you ran FAILED:\n${gateState.failedCheckOutput}\n\n` +
            `Do not declare the task done while your own check is failing, and do not explain the failure away ` +
            `as stale or expected — re-run the check if you believe it is outdated. Either fix the cause and ` +
            `re-run the check until it passes, or state plainly that the task could not be completed and quote ` +
            `the failing output.`,
        },
      ],
    });
    return 'injected';
  },
};
