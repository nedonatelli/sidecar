import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseUpstream, parseFixtures, categoryFromId } from './loader.js';

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
