import { describe, it, expect } from 'vitest';
import { createTreeSitterAnalyzer } from './treeSitterAnalyzer.js';
import { grammarsDir, hasGrammars } from './grammarsTestSupport.js';
import { getRegexAnalyzer } from './registry.js';

const CASES: Array<[string, string, string[]]> = [
  ['plain function', 'export function alpha(): number { return 1; }\n', ['alpha']],
  ['async function', 'export async function bravo(): Promise<void> {}\n', ['bravo']],
  ['generator', 'export function* charlie(): Generator<number> { yield 1; }\n', ['charlie']],
  ['async generator', 'export async function* delta(): AsyncGenerator<number> { yield 1; }\n', ['delta']],
  ['star before space', 'export function *echo(): Generator<number> { yield 1; }\n', ['echo']],
];

const fnNames = (parsed: unknown): string[] =>
  ((parsed as { elements?: Array<{ name: string; type: string }> })?.elements ?? [])
    .filter((e) => e.type === 'function')
    .map((e) => e.name);

describe.skipIf(!hasGrammars)('tree-sitter: generator declarations', () => {
  for (const [label, code, expected] of CASES) {
    it(`extracts a function symbol for ${label}`, async () => {
      const a = await createTreeSitterAnalyzer(grammarsDir);
      expect(fnNames(a.parseFileContent('p.ts', code))).toEqual(expected);
    });
  }
});

describe('regex fallback: generator declarations', () => {
  for (const [label, code, expected] of CASES) {
    it(`extracts a function symbol for ${label}`, () => {
      expect(fnNames(getRegexAnalyzer().parseFileContent('p.ts', code))).toEqual(expected);
    });
  }

  it('does not invent a symbol from an identifier merely starting with "function"', () => {
    // The star alternation must not let `functionfoo` through — a name has to
    // be separated by whitespace or by the star, never by neither.
    expect(fnNames(getRegexAnalyzer().parseFileContent('p.ts', 'const functionfoo = 1;\n'))).toEqual([]);
  });

  it('does not invent a name for an anonymous function expression', () => {
    // `function(` has no name to capture, so the declaration path must produce
    // nothing rather than reaching past it for the next identifier. Unchanged
    // by the generator fix — the old `includes('function ')` gate excluded this
    // line too, and the replacement must not start admitting it.
    expect(fnNames(getRegexAnalyzer().parseFileContent('p.ts', 'const f = function() {};\n'))).toEqual([]);
  });
});
