import type { AgentEvalCase } from './agentTypes.js';
import { AGENT_CASES } from './agentCases.js';
import { CODE_QUALITY_CASES } from './codeQualityCases.js';
import { GIT_CASES } from './gitCases.js';
import { THINKING_CASES } from './thinkingCases.js';
import { SYSTEM_CASES } from './systemCases.js';
import { MULTI_TURN_CASES } from './multiTurnCases.js';
import { DOGFOOD_CASES, DOGFOOD_LANGUAGE_AND_SCALE_CASES } from './dogfoodCases.js';
import { LARGE_FILE_EDIT_CASES, UNDERSPECIFIED_CASES } from './largeFileEditCases.js';

/**
 * Every agent eval case, in one place.
 *
 * `agent.eval.ts` and `agentBaseline.eval.ts` each built their own array, and
 * they drifted: the eval ran 70 cases while the baseline compared 61. The nine
 * missing were the `latch-*` multi-turn and `dogfood-*` real-workspace families
 * — the hardest ones, and the ones a regression would hurt most. A model could
 * have lost all multi-turn capability and the baseline would have reported no
 * regression, because it never looked.
 *
 * Nothing surfaced it either: the run printed "recorded 40/61 passing", and 61
 * reads like a total rather than a subset.
 *
 * Anything that runs the agent cases imports this. A suite assembling its own
 * array is the next divergence.
 */
export const ALL_AGENT_CASES: AgentEvalCase[] = [
  ...AGENT_CASES,
  ...CODE_QUALITY_CASES,
  ...GIT_CASES,
  ...THINKING_CASES,
  ...SYSTEM_CASES,
  ...MULTI_TURN_CASES,
  ...DOGFOOD_CASES,
  ...DOGFOOD_LANGUAGE_AND_SCALE_CASES,
  ...LARGE_FILE_EDIT_CASES,
  ...UNDERSPECIFIED_CASES,
];
