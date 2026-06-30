import { describe, it, expect } from 'vitest';
import { runBfcl, aggregate } from './runner.js';
import type { CallModel } from './runner.js';
import type { BfclCase, CaseOutcome, ParsedCall } from './types.js';

const cases: BfclCase[] = [
  {
    id: 'simple_0',
    category: 'simple',
    question: 'weather in Paris',
    functions: [
      {
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
    groundTruth: [{ get_weather: { city: ['Paris'] } }],
  },
  {
    id: 'irrelevance_0',
    category: 'irrelevance',
    question: 'write a poem',
    functions: [
      {
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
  },
];

/** Replay backend: returns canned calls keyed by question. */
function replay(map: Record<string, ParsedCall[]>): CallModel {
  return async (question: string) => map[question] ?? [];
}

describe('runBfcl (replay — no network)', () => {
  it('scores a perfect run', async () => {
    const r = await runBfcl(
      cases,
      replay({
        'weather in Paris': [{ name: 'get_weather', args: { city: 'Paris' } }],
        'write a poem': [], // correctly declines to call
      }),
    );
    expect(r.passed).toBe(2);
    expect(r.microAccuracy).toBe(1);
    expect(r.failures).toHaveLength(0);
  });

  it('records a hallucinated call on an irrelevance case as a failure', async () => {
    const r = await runBfcl(
      cases,
      replay({
        'weather in Paris': [{ name: 'get_weather', args: { city: 'Paris' } }],
        'write a poem': [{ name: 'get_weather', args: { city: 'Nowhere' } }],
      }),
    );
    expect(r.passed).toBe(1);
    expect(r.failures.map((f) => f.id)).toEqual(['irrelevance_0']);
  });

  it('counts a thrown model call as a failed case, not a crash', async () => {
    const boom: CallModel = async () => {
      throw new Error('connection refused');
    };
    const r = await runBfcl(cases, boom);
    expect(r.passed).toBe(0);
    expect(r.failures[0].reason).toContain('model call failed');
  });

  it('invokes the onCase progress hook once per case', async () => {
    const seen: CaseOutcome[] = [];
    await runBfcl(cases, replay({}), { onCase: (o) => seen.push(o) });
    expect(seen).toHaveLength(2);
  });

  it('produces identical aggregates regardless of concurrency', async () => {
    const cm = replay({ 'weather in Paris': [{ name: 'get_weather', args: { city: 'Paris' } }], 'write a poem': [] });
    const seq = await runBfcl(cases, cm, { concurrency: 1 });
    const par = await runBfcl(cases, cm, { concurrency: 4 });
    expect(par.passed).toBe(seq.passed);
    expect(par.categories).toEqual(seq.categories);
  });
});

describe('aggregate', () => {
  it('computes macro as the unweighted mean of per-category accuracy', () => {
    // simple: 1/1 = 100%, irrelevance: 0/2 = 0% → macro = 50%, micro = 1/3
    const outcomes: CaseOutcome[] = [
      { id: 's0', category: 'simple', pass: true, reason: '' },
      { id: 'i0', category: 'irrelevance', pass: false, reason: 'x' },
      { id: 'i1', category: 'irrelevance', pass: false, reason: 'x' },
    ];
    const r = aggregate(outcomes);
    expect(r.macroAccuracy).toBeCloseTo(0.5, 5);
    expect(r.microAccuracy).toBeCloseTo(1 / 3, 5);
    expect(r.categories).toHaveLength(2);
  });
});
