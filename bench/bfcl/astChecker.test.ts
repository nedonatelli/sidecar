import { describe, it, expect } from 'vitest';
import { checkCase, valueEquals } from './astChecker.js';
import type { BfclCase, BfclFunctionSchema, ParsedCall } from './types.js';

const weatherFn: BfclFunctionSchema = {
  name: 'get_weather',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['city'],
  },
};

const stockFn: BfclFunctionSchema = {
  name: 'get_stock',
  parameters: {
    type: 'object',
    properties: { ticker: { type: 'string' }, days: { type: 'integer' } },
    required: ['ticker'],
  },
};

function call(name: string, args: Record<string, unknown>): ParsedCall {
  return { name, args };
}

describe('valueEquals', () => {
  it('treats integers, floats, and numeric strings as equal', () => {
    expect(valueEquals(5, 5)).toBe(true);
    expect(valueEquals(5, 5.0)).toBe(true);
    expect(valueEquals('5', 5)).toBe(true);
    expect(valueEquals(5, '5')).toBe(true);
    expect(valueEquals(5, 6)).toBe(false);
  });

  it('coerces booleans and boolean strings', () => {
    expect(valueEquals(true, true)).toBe(true);
    expect(valueEquals('true', true)).toBe(true);
    expect(valueEquals('false', false)).toBe(true);
    expect(valueEquals(true, false)).toBe(false);
    // a boolean must not equal a number
    expect(valueEquals(true, 1)).toBe(false);
  });

  it('compares arrays order-sensitively and by length', () => {
    expect(valueEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(valueEquals([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(valueEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(valueEquals(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('compares objects recursively by key', () => {
    expect(valueEquals({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(valueEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(valueEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valueEquals({ a: { c: '5' } }, { a: { c: 5 } })).toBe(true);
  });

  it('trims strings but does not fuzzy-normalize', () => {
    expect(valueEquals(' hello ', 'hello')).toBe(true);
    expect(valueEquals('Hello', 'hello')).toBe(false);
  });

  it('does not equate an array with a non-array', () => {
    expect(valueEquals([1], 1)).toBe(false);
    expect(valueEquals({ 0: 1 }, [1])).toBe(false);
  });
});

function simpleCase(over: Partial<BfclCase> = {}): BfclCase {
  return {
    id: 'simple_0',
    category: 'simple',
    question: 'weather in Paris in celsius',
    functions: [weatherFn],
    groundTruth: [{ get_weather: { city: ['Paris'], unit: ['celsius'] } }],
    ...over,
  };
}

describe('checkCase — simple / multiple', () => {
  it('passes a correct single call', () => {
    const r = checkCase(simpleCase(), [call('get_weather', { city: 'Paris', unit: 'celsius' })]);
    expect(r.pass).toBe(true);
  });

  it('fails the wrong function name', () => {
    const r = checkCase(simpleCase(), [call('get_forecast', { city: 'Paris', unit: 'celsius' })]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('get_weather');
  });

  it('fails a value outside the acceptable set', () => {
    const r = checkCase(simpleCase(), [call('get_weather', { city: 'London', unit: 'celsius' })]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('city');
  });

  it('fails a missing required parameter', () => {
    const r = checkCase(simpleCase(), [call('get_weather', { unit: 'celsius' })]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('required');
  });

  it('fails a hallucinated parameter not in the schema', () => {
    const r = checkCase(simpleCase(), [call('get_weather', { city: 'Paris', unit: 'celsius', humidity: true })]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('hallucinated');
  });

  it('allows an optional parameter to be omitted when "" is acceptable', () => {
    const c = simpleCase({ groundTruth: [{ get_weather: { city: ['Paris'], unit: ['celsius', ''] } }] });
    const r = checkCase(c, [call('get_weather', { city: 'Paris' })]);
    expect(r.pass).toBe(true);
  });

  it('fails when an omitted parameter is not marked omittable', () => {
    const r = checkCase(simpleCase(), [call('get_weather', { city: 'Paris' })]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('unit');
  });

  it('fails when more than one call is emitted', () => {
    const r = checkCase(simpleCase(), [
      call('get_weather', { city: 'Paris', unit: 'celsius' }),
      call('get_weather', { city: 'Paris', unit: 'celsius' }),
    ]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('exactly 1');
  });

  it('multiple: picks the right function among several', () => {
    const c = simpleCase({
      id: 'multiple_0',
      category: 'multiple',
      functions: [weatherFn, stockFn],
      groundTruth: [{ get_stock: { ticker: ['AAPL'], days: ['5'] } }],
    });
    expect(checkCase(c, [call('get_stock', { ticker: 'AAPL', days: 5 })]).pass).toBe(true);
    expect(checkCase(c, [call('get_weather', { city: 'Paris', unit: 'celsius' })]).pass).toBe(false);
  });
});

describe('checkCase — parallel', () => {
  const parallelCase: BfclCase = {
    id: 'parallel_0',
    category: 'parallel',
    question: 'weather in Paris and Tokyo',
    functions: [weatherFn],
    groundTruth: [
      { get_weather: { city: ['Paris'], unit: ['celsius'] } },
      { get_weather: { city: ['Tokyo'], unit: ['celsius'] } },
    ],
  };

  it('passes both calls regardless of order', () => {
    const r = checkCase(parallelCase, [
      call('get_weather', { city: 'Tokyo', unit: 'celsius' }),
      call('get_weather', { city: 'Paris', unit: 'celsius' }),
    ]);
    expect(r.pass).toBe(true);
  });

  it('fails when a call count differs from ground truth', () => {
    const r = checkCase(parallelCase, [call('get_weather', { city: 'Paris', unit: 'celsius' })]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('expected 2');
  });

  it('fails when one expected call is unsatisfied', () => {
    const r = checkCase(parallelCase, [
      call('get_weather', { city: 'Paris', unit: 'celsius' }),
      call('get_weather', { city: 'Berlin', unit: 'celsius' }),
    ]);
    expect(r.pass).toBe(false);
  });

  it('parallel_multiple: matches calls across different functions', () => {
    const c: BfclCase = {
      id: 'parallel_multiple_0',
      category: 'parallel_multiple',
      question: 'weather in Paris and AAPL stock',
      functions: [weatherFn, stockFn],
      groundTruth: [
        { get_weather: { city: ['Paris'], unit: ['celsius'] } },
        { get_stock: { ticker: ['AAPL'], days: ['5'] } },
      ],
    };
    const r = checkCase(c, [
      call('get_stock', { ticker: 'AAPL', days: 5 }),
      call('get_weather', { city: 'Paris', unit: 'celsius' }),
    ]);
    expect(r.pass).toBe(true);
  });
});

describe('checkCase — relevance / irrelevance', () => {
  const base: BfclCase = {
    id: 'irrelevance_0',
    category: 'irrelevance',
    question: 'what is the capital of France?',
    functions: [weatherFn],
  };

  it('irrelevance passes when no call is emitted', () => {
    expect(checkCase(base, []).pass).toBe(true);
  });

  it('irrelevance fails when the model calls anyway', () => {
    const r = checkCase(base, [call('get_weather', { city: 'Paris' })]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('get_weather');
  });

  it('relevance passes when at least one call is emitted', () => {
    const c: BfclCase = { ...base, id: 'relevance_0', category: 'relevance' };
    expect(checkCase(c, [call('get_weather', { city: 'Paris' })]).pass).toBe(true);
    expect(checkCase(c, []).pass).toBe(false);
  });
});
