import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY } from '../tools.js';
import { extractExampleArgs } from './exampleReplayGuard.js';

// Catalog-wide ratchet for the example-replay guard: if a description's
// example is reworded into a form the extractor can't parse, the guard
// silently disarms for that tool. Every example with arguments must either
// parse or be explicitly acknowledged here.

// Examples that use <placeholder> values by design — unparseable, and a
// verbatim replay would already bounce on schema validation.
const KNOWN_UNPARSEABLE = new Set(['synthesize_tests', 'classify_test_failure']);

const EXAMPLE_WITH_ARGS_RE = /Example: `[A-Za-z_][\w.]*\(\s*[^)\s]/;

describe('example-replay guard catalog coverage', () => {
  it('every description example with arguments is parseable or on the known-unparseable list', () => {
    const unguarded: string[] = [];
    for (const tool of TOOL_REGISTRY) {
      const { name, description } = tool.definition;
      if (!EXAMPLE_WITH_ARGS_RE.test(description)) continue; // no example, or zero-arg
      if (extractExampleArgs(description) === null && !KNOWN_UNPARSEABLE.has(name)) {
        unguarded.push(name);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('the known-unparseable list carries no stale entries', () => {
    for (const name of KNOWN_UNPARSEABLE) {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === name);
      expect(tool, `${name} is no longer in the registry — remove it from KNOWN_UNPARSEABLE`).toBeDefined();
      expect(
        extractExampleArgs(tool!.definition.description),
        `${name}'s example now parses — remove it from KNOWN_UNPARSEABLE`,
      ).toBeNull();
    }
  });
});
