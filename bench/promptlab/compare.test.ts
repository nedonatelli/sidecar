import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readRecords, armKey, buildArms, render, checkComparable } from './compare.js';

const surface = (over: Record<string, unknown> = {}) => ({
  systemPromptChars: 26113,
  systemPromptHash: 'sysA',
  toolNames: ['edit_file', 'read_file'],
  toolCatalogHash: 'toolA',
  ragOrientationChars: 0,
  seed: 1000,
  temperature: 0,
  numCtx: 32768,
  ...over,
});
const rec = (over: Record<string, unknown> = {}) => ({
  caseId: 'c1',
  model: 'gemma4:e4b',
  passed: true,
  surface: surface(),
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (rows: object[]): string => {
  const p = path.join(dir, 'trajectories.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
};

describe('readRecords', () => {
  it('survives a truncated tail line from a run killed mid-write', () => {
    const p = path.join(dir, 't.jsonl');
    fs.writeFileSync(p, JSON.stringify(rec()) + '\n{"caseId":"broken"');
    expect(readRecords(p)).toHaveLength(1);
  });

  it('returns empty for a missing file rather than throwing', () => {
    expect(readRecords(path.join(dir, 'nope.jsonl'))).toEqual([]);
  });
});

describe('armKey', () => {
  it('names an arm by what it ran, not by a label', () => {
    // A label is a claim; a hash is a fact. Two runs called "bare" that sent
    // different prompts are different arms.
    expect(armKey(rec())).toBe(armKey(rec()));
    expect(armKey(rec())).not.toBe(armKey(rec({ surface: surface({ systemPromptHash: 'sysB' }) })));
  });

  it('separates RAG-on from RAG-off', () => {
    expect(armKey(rec({ surface: surface({ ragOrientationChars: 4366 }) }))).toMatch(/rag:4366c/);
    expect(armKey(rec())).toMatch(/rag:off/);
  });

  it('separates injection SIZES, not merely on from off', () => {
    // top-1 injects 801 chars and top-6 injects 4,366. A boolean key pooled
    // four top-k arms into one 76-trial bucket and the comparison was refused.
    const k1 = armKey(rec({ surface: surface({ ragOrientationChars: 801 }) }));
    const k6 = armKey(rec({ surface: surface({ ragOrientationChars: 4366 }) }));
    expect(k1).not.toBe(k6);
  });

  it('flags records that predate surface recording', () => {
    expect(armKey({ caseId: 'c', model: 'm', passed: true })).toBe('unrecorded-surface');
  });
});

describe('buildArms', () => {
  it('treats an api-unavailable record as TIMEOUT, never as a failure', () => {
    const arms = buildArms([rec({ passed: false, apiUnavailable: true })]);
    expect([...arms.values()][0].outcomes).toEqual(['TIMEOUT']);
  });

  it('filters by case', () => {
    const arms = buildArms([rec(), rec({ caseId: 'other' })], 'c1');
    expect([...arms.values()][0].outcomes).toHaveLength(1);
  });
});

describe('render', () => {
  it('reports INCONCLUSIVE for the 2/3-vs-0/3 shape that misled us', () => {
    const ragOn = surface({ ragOrientationChars: 4366 });
    const rows = [
      ...[true, true, false].map((p) => rec({ passed: p })),
      ...[false, false, false].map((p) => rec({ passed: p, surface: ragOn })),
    ];
    const out = render(readRecords(write(rows)), 'c1');
    expect(out).toMatch(/INCONCLUSIVE/);
    expect(out).toMatch(/trials\/arm needed to resolve/); // says what WOULD resolve it
  });

  it('reports CONCLUSIVE for the RAG result that survived significance', () => {
    // bare 10/10 vs bare+RAG 4/10, p=0.011
    const ragOn = surface({ ragOrientationChars: 4366 });
    const rows = [
      ...Array.from({ length: 10 }, () => rec({ passed: true })),
      ...Array.from({ length: 10 }, (_, i) => rec({ passed: i < 4, surface: ragOn })),
    ];
    expect(render(readRecords(write(rows)), 'c1')).toMatch(/CONCLUSIVE/);
  });

  it('warns when records cannot be attributed to an arm', () => {
    const out = render([rec(), { caseId: 'c1', model: 'm', passed: false }], 'c1');
    expect(out).toMatch(/predate surface recording/);
  });

  it('marks an arm INCOMPLETE when fewer trials ran than requested', () => {
    const out = render([rec(), rec()], 'c1', 3);
    expect(out).toMatch(/INCOMPLETE/);
  });
});

describe('checkComparable', () => {
  it('refuses a comparison whose tool catalog moved for an undeclared reason', () => {
    // The live failure: 60 chars added to one tool's description moved the
    // baseline while the system prompt was the declared variable.
    const a = rec();
    const b = rec({ surface: surface({ systemPromptHash: 'sysB', toolCatalogHash: 'toolB' }) });
    expect(checkComparable(a, b, ['systemPromptMode'], ['c1'], 3)).toMatch(/NOT comparable/);
  });

  it('accepts a comparison differing only on the declared axis', () => {
    const b = rec({ surface: surface({ systemPromptHash: 'sysB' }) });
    expect(checkComparable(rec(), b, ['systemPromptMode'], ['c1'], 3)).toMatch(/^comparable/);
  });

  it('warns about an unseeded run at non-zero temperature', () => {
    const s = surface({ seed: null, temperature: 0.2 });
    const out = checkComparable(rec({ surface: s }), rec({ surface: s }), [], ['c1'], 3);
    expect(out).toMatch(/without a seed/);
  });
});
