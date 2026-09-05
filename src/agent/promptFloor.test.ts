import { describe, it, expect } from 'vitest';
import { buildBaseSystemPrompt } from '../webview/handlers/basePrompt.js';
import { getToolDefinitionsForTier } from './tools.js';
import { charsToTokens } from '../config/tokenEstimation.js';

// ---------------------------------------------------------------------------
// The prompt FLOOR: what every run pays before the conversation starts.
//
// This exists because the floor grew past a budget and silently disabled two
// regression cases. `large-file-edit-under-compression` and
// `multi-step-plan-survives-compression` both budgeted maxTokens: 9000 to force
// compression. Once the system prompt plus tool schemas passed ~12.5K, the loop
// was over budget on turn one, terminated out-of-resources, and asserted
// nothing -- for however long the floor had been above 9000. It read as a model
// failure, which is what an eval case that dies early always looks like.
//
// Worse, the meta-test guarding those fixtures asserted `maxTokens < 12_000` --
// pinning the exact bound that made them unfixable. Nothing measured the thing
// both depended on.
//
// So: measure the floor and fail when it crosses a line. The ceiling is
// deliberately loose. This is not a budget to optimise toward; it is a tripwire
// that says "the floor moved, go check what depended on it".
// ---------------------------------------------------------------------------

/**
 * Tripwire, not a target. Raise it deliberately, and check what breaks first.
 *
 * Measured when written: 13,332 tokens (system 6,529 + tools 6,803). That
 * agrees with the live evidence -- two eval cases died reporting "token budget
 * exceeded (~12542)" and "(~12656)" -- with the small gap explained by the SWE
 * harness filtering run_tests out of its tool set.
 */
const FLOOR_CEILING_TOKENS = 20_000;

function measureFloor(): { systemTokens: number; toolTokens: number; total: number } {
  const systemPrompt = buildBaseSystemPrompt({
    isLocal: true,
    extensionVersion: '0.0.0-test',
    repoUrl: '',
    docsUrl: '',
    root: '/tmp/floor-probe',
    approvalMode: 'autonomous',
  });
  // What actually goes on the wire. NOT getToolDefinitions(): the 'full' tier
  // gives core tools full schemas and stubs the rest, and for a local model the
  // core set shrinks further. The raw registry measures ~19.2K, the tier the
  // agent really sends measures far less -- pinning the wrong one would make
  // this tripwire fire on a cost nothing pays.
  const tools = getToolDefinitionsForTier('full');
  const systemTokens = charsToTokens(systemPrompt.length);
  const toolTokens = charsToTokens(JSON.stringify(tools).length);
  return { systemTokens, toolTokens, total: systemTokens + toolTokens };
}

describe('prompt floor', () => {
  it('stays under the tripwire', () => {
    const { systemTokens, toolTokens, total } = measureFloor();
    expect(
      total,
      `Prompt floor is ${total} tokens (system ${systemTokens} + tools ${toolTokens}), over the ${FLOOR_CEILING_TOKENS} tripwire.\n` +
        `Every run pays this before its first message, and compression cannot reclaim any of it -- it only shrinks messages.\n` +
        `Before raising the ceiling, check every maxTokens in tests/llm-eval/: a budget below the floor makes its case die\n` +
        `out-of-resources on turn one and assert nothing, which is how two compression fixtures were lost.`,
    ).toBeLessThan(FLOOR_CEILING_TOKENS);
  });

  it('leaves headroom under the budgets the eval fixtures use', () => {
    // The concrete invariant the fixtures need: a case cannot compress its way
    // out of a budget the floor already exceeds. Compression only touches
    // messages, so a budget must clear the floor with room for a conversation.
    const { total } = measureFloor();
    const smallestFixtureBudget = 64_000; // largeFileEditCases + agentCases
    expect(
      total * 2,
      `The prompt floor (${total}) is within 2x of the smallest eval budget (${smallestFixtureBudget}). ` +
        `Those cases will spend most of their window on the floor and may never reach the behaviour they test.`,
    ).toBeLessThan(smallestFixtureBudget);
  });
});
