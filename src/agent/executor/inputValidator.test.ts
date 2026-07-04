import { describe, it, expect } from 'vitest';
import { validateToolInput } from './inputValidator.js';

const schema = {
  type: 'object' as const,
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
    files: { type: 'array' },
    count: { type: 'number' },
    recursive: { type: 'boolean' },
  },
  required: ['path'],
};

describe('validateToolInput', () => {
  it('accepts a well-formed input', () => {
    expect(validateToolInput({ path: 'a.ts', content: 'x', files: ['a'], count: 3 }, schema)).toBeNull();
  });

  it('accepts a no-argument call (undefined input) when nothing is required', () => {
    expect(validateToolInput(undefined, { type: 'object', properties: {} })).toBeNull();
  });

  it('reports a missing required parameter', () => {
    expect(validateToolInput({ content: 'x' }, schema)).toMatch(/missing required parameter 'path'/);
  });

  it('reports a missing required parameter on undefined input', () => {
    expect(validateToolInput(undefined, schema)).toMatch(/missing required parameter 'path'/);
  });

  it('rejects a number where a string is declared (the content:123 bug)', () => {
    expect(validateToolInput({ path: 'a.ts', content: 123 }, schema)).toMatch(/'content' must be a string, got number/);
  });

  it('rejects a non-array where an array is declared', () => {
    expect(validateToolInput({ path: 'a.ts', files: 'a.ts' }, schema)).toMatch(/'files' must be an array/);
  });

  it('rejects a top-level array input', () => {
    expect(validateToolInput(['a', 'b'], schema)).toMatch(/must be a JSON object, got array/);
  });

  it('stays lenient on number and boolean fields (coercion-friendly)', () => {
    // A numeric string for a number field, and a string for a boolean field,
    // are NOT rejected — models routinely send these and tools coerce them.
    expect(validateToolInput({ path: 'a.ts', count: '3', recursive: 'true' }, schema)).toBeNull();
  });

  it('ignores properties not declared in the schema', () => {
    expect(validateToolInput({ path: 'a.ts', extra: { nested: 1 } }, schema)).toBeNull();
  });

  it('returns null when there is no schema', () => {
    expect(validateToolInput({ anything: 1 }, undefined)).toBeNull();
  });
});
