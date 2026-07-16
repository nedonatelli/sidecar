import { describe, it, expect } from 'vitest';
import { summarizeLongHorizon, type LongHorizonTurnResult } from './longHorizonHarness.js';

const turn = (index: number, passed: boolean): LongHorizonTurnResult => ({
  index,
  label: `turn ${index + 1}`,
  passed,
  failures: passed ? [] : ['assertion failed'],
  trajectory: [],
});

const base = {
  caseId: 'c',
  totalTurns: 3,
  requiresCompression: false,
  compressionCount: 0,
  finalHistoryLength: 12,
  apiUnavailable: false,
  durationMs: 100,
};

describe('summarizeLongHorizon — the verdict honesty rules', () => {
  it('passes only when EVERY turn passed', () => {
    expect(summarizeLongHorizon({ ...base, turns: [turn(0, true), turn(1, true), turn(2, true)] }).passed).toBe(true);
  });

  it('fails when any turn failed', () => {
    const r = summarizeLongHorizon({ ...base, turns: [turn(0, true), turn(1, false)] });
    expect(r.passed).toBe(false);
  });

  it('fails when the run stopped short of all turns (a failed turn halts the conversation)', () => {
    // Only 1 of 3 turns ran — the conversation diverged and stopped. Not a pass,
    // even though the one turn that ran passed.
    const r = summarizeLongHorizon({ ...base, turns: [turn(0, true)] });
    expect(r.passed).toBe(false);
  });

  it('a compression-required case that never compacted is VACUOUS, not a pass', () => {
    // The honesty gate. A "survives compaction" case where compaction never fired
    // proved nothing — reporting it as a pass would be the same lie as claiming a
    // lift with no discordant pairs.
    const r = summarizeLongHorizon({
      ...base,
      requiresCompression: true,
      compressionCount: 0,
      turns: [turn(0, true), turn(1, true), turn(2, true)],
    });
    expect(r.vacuous).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('a compression-required case that DID compact and passed every turn is a real pass', () => {
    const r = summarizeLongHorizon({
      ...base,
      requiresCompression: true,
      compressionCount: 2,
      turns: [turn(0, true), turn(1, true), turn(2, true)],
    });
    expect(r.vacuous).toBe(false);
    expect(r.passed).toBe(true);
  });

  it('api-unavailable is neither pass nor fail', () => {
    const r = summarizeLongHorizon({
      ...base,
      apiUnavailable: true,
      turns: [turn(0, true), turn(1, true), turn(2, true)],
    });
    expect(r.passed).toBe(false);
    expect(r.apiUnavailable).toBe(true);
  });

  it('an empty run (zero turns executed) is not a pass', () => {
    expect(summarizeLongHorizon({ ...base, turns: [] }).passed).toBe(false);
  });
});

describe('summarizeLongHorizon — editDiffShownCount (verify the diff flag fired)', () => {
  const turnWithTraj = (results: Array<{ name: string; result: string }>): LongHorizonTurnResult => ({
    index: 0,
    label: 'edit turn',
    passed: true,
    failures: [],
    trajectory: results.map((r, i) => ({
      type: 'tool_result' as const,
      name: r.name,
      result: r.result,
      isError: false,
      id: `t${i}`,
    })),
  });

  it('counts edit_file results carrying the outcome-visibility diff marker', () => {
    const r = summarizeLongHorizon({
      ...base,
      totalTurns: 1,
      turns: [
        turnWithTraj([
          { name: 'edit_file', result: 'File edited: a.ts\nWhat changed (verify this is what you intended):\n+foo' },
          { name: 'edit_file', result: 'File edited: b.ts' }, // no diff (flag off for this one)
          { name: 'read_file', result: 'What changed (verify …' }, // wrong tool — must not count
        ]),
      ],
    });
    expect(r.editDiffShownCount).toBe(1);
  });

  it('is 0 when no edit result carried the diff — the flag-off arm', () => {
    const r = summarizeLongHorizon({
      ...base,
      totalTurns: 1,
      turns: [turnWithTraj([{ name: 'edit_file', result: 'File edited: a.ts' }])],
    });
    expect(r.editDiffShownCount).toBe(0);
  });
});
