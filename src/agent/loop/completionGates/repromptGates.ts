// The grounding / verification reprompt gates — a cluster of once-per-run
// nudges that share one shape: check a fired-flag, build a reprompt from the
// conversation, and if there's something to say, inject it and latch the flag.
// Factored through `repromptGate` so each is a few lines of spec. All are gated
// by the completion-gate master (no individual flags yet — they're minor
// nudges; give one its own flag if a reason to study it in isolation appears).
import {
  buildNoReadReprompt,
  buildNoShellReprompt,
  buildNoGroundingReprompt,
  buildUnverifiedClaimReprompt,
  buildMcpMutationVerifyReprompt,
  buildNoFileWriteReprompt,
} from '../../completionGate.js';
import type { LoopState } from '../state.js';
import type { CompletionGate } from './types.js';

/** The once-per-run latch fields on gateState these gates use. */
type RepromptFiredFlag =
  | 'noReadRepromptFired'
  | 'noShellRepromptFired'
  | 'noGroundingRepromptFired'
  | 'unverifiedClaimRepromptFired'
  | 'mcpMutationRepromptFired'
  | 'noFileWriteRepromptFired';

interface RepromptSpec {
  name: string;
  firedFlag: RepromptFiredFlag;
  /** Build the reprompt from the run state, or null when the gate shouldn't fire. */
  build(state: LoopState): string | null | Promise<string | null>;
  /** User-visible status line emitted when the gate fires. */
  onText: string;
  /** Output-channel log line when the gate fires. */
  logMsg: string;
}

function repromptGate(spec: RepromptSpec): CompletionGate {
  return {
    name: spec.name,
    enabled: (config) => config.completionGateEnabled !== false,
    async maybeInject(state, ctx) {
      const { gateState, logger } = state;
      if (gateState[spec.firedFlag]) return 'skip';
      const reprompt = await spec.build(state);
      if (!reprompt) return 'skip';
      gateState[spec.firedFlag] = true;
      logger?.info(spec.logMsg);
      ctx.callbacks.onText(spec.onText);
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    },
  };
}

export const noReadGate = repromptGate({
  name: 'no-read',
  firedFlag: 'noReadRepromptFired',
  build: (s) => buildNoReadReprompt(s.messages, s.gateState.editedFiles, s.gateState.currentUserRequest),
  onText: '\n\n📂 Reading file before answering...\n',
  logMsg: 'No-read gate fired — file mentioned but no read tool called for it',
});

export const noShellGate = repromptGate({
  name: 'no-shell',
  firedFlag: 'noShellRepromptFired',
  build: (s) => buildNoShellReprompt(s.messages, s.gateState.currentUserRequest),
  onText: '\n\n🔍 Running shell command to get live data...\n',
  logMsg: 'No-shell gate fired — workspace metric query answered without a shell command',
});

export const noGroundingGate = repromptGate({
  name: 'no-grounding',
  firedFlag: 'noGroundingRepromptFired',
  build: (s) => buildNoGroundingReprompt(s.messages, s.gateState.currentUserRequest),
  onText: '\n\n🔎 Reading the code before reviewing it...\n',
  logMsg: 'No-grounding gate fired — codebase review answered without reading any code',
});

export const unverifiedClaimGate = repromptGate({
  name: 'unverified-claim',
  firedFlag: 'unverifiedClaimRepromptFired',
  build: (s) => buildUnverifiedClaimReprompt(s.messages, undefined, s.gateState.currentUserRequest),
  onText: '\n\n🧾 Verifying citations before finishing...\n',
  logMsg: 'Unverified-claim gate fired — review cited a nonexistent path or an unverified claim',
});

export const mcpMutationGate = repromptGate({
  name: 'mcp-mutation-verify',
  firedFlag: 'mcpMutationRepromptFired',
  build: (s) => buildMcpMutationVerifyReprompt(s.gateState),
  onText: '\n\n🔁 Verifying external writes landed...\n',
  logMsg: 'MCP mutation-verify gate fired — external write(s) never read back',
});

export const noFileWriteGate = repromptGate({
  name: 'no-file-write',
  firedFlag: 'noFileWriteRepromptFired',
  build: (s) => buildNoFileWriteReprompt(s.messages, s.gateState.editedFiles, s.gateState.currentUserRequest),
  onText: '\n\n📝 Checking named files were written...\n',
  logMsg: 'No-file-write gate fired — named file(s) not written',
});
