import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ALL_AGENT_CASES } from './allCases.js';

// The regression baseline silently covered 61 of 70 cases.
//
// `agent.eval.ts` imported seven case sets; `agentBaseline.eval.ts` imported
// five, each building its own ALL_CASES. The nine it missed were the `latch-*`
// multi-turn and `dogfood-*` real-workspace families — the hardest ones. A model
// could have lost all multi-turn capability and the baseline would have reported
// no regression, because it never compared them.
//
// Nothing in the output hinted at it: the run printed "recorded 40/61 passing",
// and 61 reads like a total.

const SUITES = ['tests/llm-eval/agent.eval.ts', 'tests/llm-eval/agentBaseline.eval.ts'];

describe('ALL_AGENT_CASES', () => {
  it('is the single case list both suites use', () => {
    // A suite assembling its own array is a second list waiting to drift. This
    // is the check that would have caught the original divergence.
    const offenders = SUITES.filter((f) => {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      return !src.includes('ALL_AGENT_CASES');
    });
    expect(offenders).toEqual([]);
  });

  it('includes the multi-turn and dogfood families the baseline used to miss', () => {
    const ids = new Set(ALL_AGENT_CASES.map((c) => c.id));
    for (const id of [
      'latch-stale-fact',
      'latch-topic-switch',
      'latch-thanks-after-edit',
      'latch-instruction-bleed',
      'dogfood-add-jsdoc',
      'dogfood-rename-no-corruption',
      'dogfood-no-work-after-done',
      'dogfood-python-syntax-guard',
      'dogfood-large-file-edit',
    ]) {
      expect(ids, `${id} must be covered`).toContain(id);
    }
  });

  it('has no duplicate case ids', () => {
    const ids = ALL_AGENT_CASES.map((c) => c.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
