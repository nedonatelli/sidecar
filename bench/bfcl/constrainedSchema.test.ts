/* eslint-disable @typescript-eslint/no-explicit-any -- these assertions walk an
   untyped JSON Schema the builder emits; a hand-written deep type for it would
   duplicate the schema and rot beside it. */
import { describe, it, expect } from 'vitest';
import { buildToolCallSchema, parseConstrainedContent } from './constrainedSchema.js';
import type { BfclFunctionSchema } from './types.js';

const weather: BfclFunctionSchema = {
  name: 'get_weather',
  parameters: { type: 'dict', properties: { city: { type: 'string' }, days: { type: 'integer' } }, required: ['city'] },
};
const stock: BfclFunctionSchema = {
  name: 'get_stock',
  parameters: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
};

describe('buildToolCallSchema', () => {
  it('wraps a single function directly (no oneOf), normalizing BFCL types', () => {
    const s = buildToolCallSchema([weather]) as any;
    expect(s.type).toBe('object');
    expect(s.required).toEqual(['tool_calls']);
    const item = s.properties.tool_calls.items;
    expect(item.properties.name.enum).toEqual(['get_weather']);
    // dict → object, integer preserved; top-level hallucinated params forbidden
    expect(item.properties.arguments.type).toBe('object');
    expect(item.properties.arguments.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);
  });

  it('uses oneOf across multiple functions', () => {
    const s = buildToolCallSchema([weather, stock]) as any;
    const oneOf = s.properties.tool_calls.items.oneOf;
    expect(oneOf).toHaveLength(2);
    expect(oneOf.map((o: any) => o.properties.name.enum[0])).toEqual(['get_weather', 'get_stock']);
  });

  it('allows an empty tool_calls array (the irrelevance case stays expressible)', () => {
    const s = buildToolCallSchema([weather]) as any;
    expect(s.properties.tool_calls.type).toBe('array');
    // array with no minItems → [] is valid
    expect(s.properties.tool_calls.minItems).toBeUndefined();
  });
});

describe('parseConstrainedContent', () => {
  it('parses the constrained object shape into normalized calls', () => {
    const out = parseConstrainedContent('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}');
    expect(out).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }]);
  });

  it('returns [] for an empty tool_calls array (irrelevance)', () => {
    expect(parseConstrainedContent('{"tool_calls":[]}')).toEqual([]);
  });

  it('defaults missing arguments to {} and drops nameless entries', () => {
    const out = parseConstrainedContent('{"tool_calls":[{"name":"f"},{"arguments":{"x":1}}]}');
    expect(out).toEqual([{ name: 'f', args: {} }]);
  });

  it('returns [] on unparseable content', () => {
    expect(parseConstrainedContent('not json')).toEqual([]);
  });
});
