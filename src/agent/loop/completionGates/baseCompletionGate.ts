import { MAX_GATE_INJECTIONS } from '../../../config/constants.js';
import {
  checkCompletionGate,
  buildGateInjection,
  describeFindingKinds,
  type GateFinding,
} from '../../completionGate.js';
import { recordDecision } from '../../decisions.js';
import type { CompletionGate, GateContext } from './types.js';
import type { LoopState } from '../state.js';
import { injectNudge } from '../nudge.js';
import { isScratchCandidate } from '../scratchCleanup.js';
import { isToolBudgetSpent } from '../toolBudget.js';
import { resolveIterationTools } from '../streamTurn.js';

/** The tools that can run a test or checker. */
const COMMAND_TOOLS = ['run_command', 'run_tests'] as const;

/**
 * Whether the model can still run a command this turn: `run_command` or
 * `run_tests` is offered and its budget is not spent. When neither can run, a
 * demand to run tests is one the model cannot meet (#505).
 */
export function canRunCommands(state: LoopState, ctx?: Pick<GateContext, 'options'>): boolean {
  const offered = new Set([
    ...(resolveIterationTools(state) ?? []).map((t) => t.name),
    ...(ctx?.options.extraTools ?? []).map((t) => t.definition.name),
  ]);
  return COMMAND_TOOLS.some((name) => offered.has(name) && !isToolBudgetSpent(state, name));
}

/**
 * The findings worth reprompting for (#505). Dropped:
 * - every finding on a scratch script (`repro.py`, `reproduce_issue.py`, ...;
 *   the names scratch cleanup moves out at the end of the run). Asking for the
 *   project's tests after an edit to a throwaway script verifies nothing:
 *   26 of gemma4:26b-a4b's 128 Lite-300 firings named only scratch files.
 * - demands that need a command run, when no command can run: 70 of 236
 *   Lite-300 firings came after `run_command` had stopped accepting calls,
 *   and the gate re-fired on each attempt until it gave up.
 * A lint finding stays either way: get_diagnostics, or the syntax gate's
 * clean parse, can satisfy it without a shell.
 */
export function actionableFindings(findings: readonly GateFinding[], commandsCanRun: boolean): GateFinding[] {
  return findings.filter((f) => {
    if (isScratchCandidate(f.file)) return false;
    // checkCompletionGate builds one finding per kind, so a test-run finding
    // carries nothing else that could still be met.
    return commandsCanRun || !(f.needsTestRun || f.missingTest !== undefined);
  });
}

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
      recordDecision(
        logger,
        { kind: 'completion_gate', action: 'exhausted', max: maxGateInjections },
        `Completion gate exhausted (${maxGateInjections} injections) — allowing termination with unverified edits`,
        'warn',
      );
      return 'skip';
    }

    const all = await checkCompletionGate(gateState);
    if (all.length === 0) return 'skip';
    const commandsCanRun = canRunCommands(state, ctx);
    const findings = actionableFindings(all, commandsCanRun);
    if (findings.length < all.length) {
      recordDecision(
        logger,
        {
          kind: 'completion_gate',
          action: 'waived',
          findings: describeFindingKinds(all.filter((f) => !findings.includes(f))),
          files: [...new Set(all.filter((f) => !findings.includes(f)).map((f) => f.file))],
          commandsCanRun,
        },
        `Completion gate waived ${all.length - findings.length} finding(s): scratch files, or no command can run`,
      );
    }
    if (findings.length === 0) return 'skip';

    gateState.gateInjections++;
    const injection = buildGateInjection(findings, gateState.gateInjections, maxGateInjections);
    recordDecision(
      logger,
      {
        kind: 'completion_gate',
        action: 'fired',
        attempt: gateState.gateInjections,
        max: maxGateInjections,
        findings: describeFindingKinds(findings),
        files: [...new Set(findings.map((f) => f.file))],
      },
      `Completion gate fired (#${gateState.gateInjections}/${maxGateInjections}): ${findings.length} unverified edit(s)`,
    );
    ctx.callbacks.onText('\n\n🔒 Verifying changes before completion...\n');
    injectNudge(
      state,
      'completion',
      [{ type: 'text' as const, text: injection }],
      [...new Set(findings.map((f) => f.file))],
    );
    return 'injected';
  },
};
