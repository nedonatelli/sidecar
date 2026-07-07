import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseUpstream, parseFixtures, categoryFromId, sampleCases } from './loader.js';
import type { BfclCase } from './types.js';

describe('categoryFromId', () => {
  it('maps id prefixes to categories, longest-prefix first', () => {
    expect(categoryFromId('simple_3')).toBe('simple');
    expect(categoryFromId('parallel_2')).toBe('parallel');
    // parallel_multiple must win over parallel
    expect(categoryFromId('parallel_multiple_7')).toBe('parallel_multiple');
    expect(categoryFromId('irrelevance_0')).toBe('irrelevance');
    expect(categoryFromId('live_simple_0')).toBe(null);
  });
});

describe('parseUpstream', () => {
  it('merges question + answer JSONL by id and flattens turns', () => {
    const questions = [
      JSON.stringify({
        id: 'simple_0',
        question: [[{ role: 'user', content: 'weather in Paris?' }]],
        function: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      }),
      JSON.stringify({
        id: 'irrelevance_0',
        question: [[{ role: 'user', content: 'write a poem' }]],
        function: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      }),
    ].join('\n');
    const answers = JSON.stringify({ id: 'simple_0', ground_truth: [{ get_weather: { city: ['Paris'] } }] });

    const cases = parseUpstream(questions, answers);
    expect(cases).toHaveLength(2);

    const simple = cases.find((c) => c.id === 'simple_0')!;
    expect(simple.category).toBe('simple');
    expect(simple.question).toBe('weather in Paris?');
    expect(simple.groundTruth).toEqual([{ get_weather: { city: ['Paris'] } }]);

    // irrelevance has no answer row — groundTruth omitted, not crashed
    const irr = cases.find((c) => c.id === 'irrelevance_0')!;
    expect(irr.groundTruth).toBeUndefined();
  });

  it('skips ids with an unrecognized category', () => {
    const questions = JSON.stringify({
      id: 'executable_simple_0',
      question: [[{ role: 'user', content: 'x' }]],
      function: [],
    });
    expect(parseUpstream(questions, '')).toHaveLength(0);
  });

  it('flattens multi-message turns, keeping only user content', () => {
    const questions = JSON.stringify({
      id: 'simple_9',
      question: [
        [
          { role: 'system', content: 'be helpful' },
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      ],
      function: [],
    });
    expect(parseUpstream(questions, '')[0].question).toBe('first\nsecond');
  });
});

describe('parseFixtures + bundled fixtures', () => {
  it('rejects a non-array', () => {
    expect(() => parseFixtures('{}')).toThrow();
  });

  it('rejects a malformed case', () => {
    expect(() => parseFixtures('[{"id":"x"}]')).toThrow();
  });

  it('loads the bundled AST fixtures and covers every AST category', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'ast.json'), 'utf-8');
    const cases = parseFixtures(raw);
    expect(cases.length).toBeGreaterThanOrEqual(8);
    const cats = new Set(cases.map((c) => c.category));
    for (const cat of ['simple', 'multiple', 'parallel', 'parallel_multiple', 'irrelevance', 'relevance']) {
      expect(cats.has(cat as never)).toBe(true);
    }
    // every non-relevance/irrelevance case carries ground truth
    for (const c of cases) {
      if (c.category !== 'irrelevance' && c.category !== 'relevance') {
        expect(c.groundTruth, c.id).toBeTruthy();
      }
    }
  });
});

describe('sampleCases', () => {
  const mk = (id: string, category: BfclCase['category']): BfclCase => ({
    id,
    category,
    question: 'q',
    functions: [],
  });

  it('returns all cases unchanged when n >= cases.length', () => {
    const cases = [mk('simple_0', 'simple'), mk('simple_1', 'simple')];
    expect(sampleCases(cases, 5)).toEqual(cases);
  });

  it('is deterministic — identical input yields an identical slice', () => {
    const cases = Array.from({ length: 40 }, (_, i) => mk(`simple_${i}`, 'simple'));
    expect(sampleCases(cases, 10)).toEqual(sampleCases(cases, 10));
  });

  it('preserves category mix — a small sample still spans every category present', () => {
    const cases = [
      ...Array.from({ length: 50 }, (_, i) => mk(`simple_${i}`, 'simple')),
      ...Array.from({ length: 10 }, (_, i) => mk(`multiple_${i}`, 'multiple')),
      ...Array.from({ length: 4 }, (_, i) => mk(`irrelevance_${i}`, 'irrelevance')),
    ];
    const sample = sampleCases(cases, 20);
    const cats = new Set(sample.map((c) => c.category));
    expect(cats.has('simple')).toBe(true);
    expect(cats.has('multiple')).toBe(true);
    expect(cats.has('irrelevance')).toBe(true);
  });

  it('never returns more than n cases', () => {
    const cases = Array.from({ length: 100 }, (_, i) => mk(`simple_${i}`, 'simple'));
    expect(sampleCases(cases, 20).length).toBeLessThanOrEqual(20);
  });

  it('a single-category set still samples proportionally within it (stride, not just first-n)', () => {
    const cases = Array.from({ length: 100 }, (_, i) => mk(`simple_${String(i).padStart(3, '0')}`, 'simple'));
    const sample = sampleCases(cases, 10);
    const ids = sample.map((c) => c.id);
    // Not just the first 10 sorted ids — confirms real striding across the range.
    expect(ids).not.toEqual(cases.slice(0, 10).map((c) => c.id));
  });

  it('returns sorted-by-id output regardless of input order', () => {
    const cases = [mk('simple_2', 'simple'), mk('simple_0', 'simple'), mk('simple_1', 'simple')];
    expect(sampleCases(cases, 2).map((c) => c.id)).toEqual([...sampleCases(cases, 2).map((c) => c.id)].sort());
  });
});
