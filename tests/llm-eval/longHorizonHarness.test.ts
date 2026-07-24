import { describe, it, expect } from 'vitest';
import { summarizeLongHorizon, type LongHorizonTurnResult, classifyFailureMode } from './longHorizonHarness.js';

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

describe('classifyFailureMode (reachability vs time-to-solution)', () => {
  const turn = (passed: boolean, trajectory: unknown[]) =>
    ({ index: 0, label: 't', passed, failures: [], trajectory }) as never;
  const err = (name: string) => ({ type: 'tool_result', name, result: 'Error: x', isError: true });
  const call = (name: string) => ({ type: 'tool_call', name, input: {}, id: 'i' });
  const ok = (name: string) => ({ type: 'tool_result', name, result: 'done', isError: false });

  it('a passed run is converged', () => {
    expect(classifyFailureMode(true, [turn(true, [])])).toBe('converged');
  });

  it('an empty failing turn is progressing — the budget killed it before it began', () => {
    expect(classifyFailureMode(false, [turn(false, [])])).toBe('progressing');
  });

  it('a turn cut off awaiting a tool result is progressing', () => {
    expect(classifyFailureMode(false, [turn(false, [call('read_file'), ok('read_file'), call('write_file')])])).toBe(
      'progressing',
    );
  });

  it('three errors from one tool is stuck — the gemma4 insert-thrash signature', () => {
    const t = turn(false, [
      call('edit_file'),
      err('edit_file'),
      call('edit_file'),
      err('edit_file'),
      call('edit_file'),
      err('edit_file'),
    ]);
    expect(classifyFailureMode(false, [t])).toBe('stuck');
  });

  it('active work that completes but fails assertions is diverged', () => {
    const t = turn(false, [call('write_file'), ok('write_file'), { type: 'text', text: 'done!' }]);
    expect(classifyFailureMode(false, [t])).toBe('diverged');
  });
});

describe('classifyFailureMode — budget exhaustion dominates (sleep-clip regression)', () => {
  const activeTurn = {
    index: 0,
    label: 't',
    passed: false,
    failures: ['x'],
    trajectory: [
      { type: 'text', text: 'I will start' },
      { type: 'tool_call', name: 'read_file', input: {}, id: 'i' },
      { type: 'tool_result', name: 'read_file', result: 'ok', isError: false, id: 'i' },
    ],
  } as never;

  it('a run that consumed its wall-clock budget is progressing, whatever its last event was', () => {
    // Live miss: a machine-sleep-clipped haiku turn (3 events, 996s of a
    // 1000s budget, last event a tool_result) read as diverged.
    expect(classifyFailureMode(false, [activeTurn], { durationMs: 996_000, timeoutMs: 1_000_000 })).toBe('progressing');
  });

  it('the same trajectory with clock to spare is judged on its events', () => {
    expect(classifyFailureMode(false, [activeTurn], { durationMs: 200_000, timeoutMs: 1_000_000 })).toBe('diverged');
  });
});
