import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { splitTopLevelArgs, coerceArgValue, parseMangledToolName } from './textParsing.js';

// Property-based tests for the pure tool-call parsing helpers. These assert
// invariants that hold for ALL inputs — catching the equivalence-class edge
// cases (adversarial quoting, nested brackets, empty strings) that fixed
// examples miss, and hardening the code that keeps local-model tool calls
// intact. Complements the example tests + mutation testing in textParsing.test.ts.

const IDENT = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/);
// A string safe to embed inside a double-quoted value: no `"` and no backslash.
const QUOTE_SAFE = fc.stringMatching(/^[^"\\]*$/);

describe('splitTopLevelArgs — properties', () => {
  it('is total: never throws, always returns an array', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(Array.isArray(splitTopLevelArgs(s))).toBe(true);
      }),
    );
  });

  it('never splits on a comma inside a double-quoted value', () => {
    fc.assert(
      fc.property(QUOTE_SAFE, QUOTE_SAFE, (v1, v2) => {
        // Two kwargs; each value may itself contain commas/brackets — they are
        // protected by the quotes and must not cause an extra split.
        const parts = splitTopLevelArgs(`a="${v1}", b="${v2}"`);
        expect(parts).toEqual([`a="${v1}"`, ` b="${v2}"`]);
      }),
    );
  });

  it('never splits on a comma inside [] brackets', () => {
    const innerCommas = fc.stringMatching(/^[a-z0-9, ]*$/);
    fc.assert(
      fc.property(innerCommas, (x) => {
        expect(splitTopLevelArgs(`a=[${x}], b=1`)).toEqual([`a=[${x}]`, ' b=1']);
      }),
    );
  });

  it('returns a single element when there is no top-level comma', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[^",]*$/), (v) => {
        // No `"` and no `,` → no top-level split possible; `path=` guarantees a
        // non-empty part, so the whole string comes back as one element.
        expect(splitTopLevelArgs(`path=${v}`)).toEqual([`path=${v}`]);
      }),
    );
  });
});

describe('coerceArgValue — properties', () => {
  it('is total: never throws for any input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        coerceArgValue(s);
      }),
    );
  });

  it('strips a matching pair of double quotes → the inner string verbatim (no escapes)', () => {
    // Backslash-free only: a double-quoted literal WITH escapes is JSON-decoded
    // (code-as-text recovery — `content="a\nb"` must yield a real newline), so
    // verbatim-strip is the contract only when no escape sequences are present.
    const inner = fc.stringMatching(/^[^"\\]*$/);
    fc.assert(
      fc.property(inner, (s) => {
        expect(coerceArgValue(`"${s}"`)).toBe(s);
      }),
    );
  });

  it('JSON-decodes any JSON-encodable string: coerceArgValue(JSON.stringify(s)) === s', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(coerceArgValue(JSON.stringify(s))).toBe(s);
      }),
    );
  });

  it('round-trips integers (String(n) → n as a number)', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        expect(coerceArgValue(String(n))).toBe(n);
      }),
    );
  });

  it('leaves a non-keyword alphabetic bareword as its own string', () => {
    const KEYWORDS = new Set(['true', 'True', 'false', 'False', 'null', 'None']);
    const bare = fc.stringMatching(/^[A-Za-z]{1,12}$/).filter((s) => !KEYWORDS.has(s));
    fc.assert(
      fc.property(bare, (s) => {
        expect(coerceArgValue(s)).toBe(s);
      }),
    );
  });
});

describe('parseMangledToolName — properties', () => {
  it('is total: returns null or an object with a string name', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = parseMangledToolName(s);
        expect(r === null || typeof r.name === 'string').toBe(true);
      }),
    );
  });

  it('never yields a name that is not a plain identifier', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = parseMangledToolName(s);
        if (r) expect(r.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      }),
    );
  });

  it('treats a plain identifier (no parentheses) as not a call expression', () => {
    fc.assert(
      fc.property(IDENT, (name) => {
        expect(parseMangledToolName(name)).toBeNull();
      }),
    );
  });

  it('recovers a single quoted string kwarg from `name(key="value")`', () => {
    fc.assert(
      fc.property(IDENT, IDENT, QUOTE_SAFE, (name, key, value) => {
        expect(parseMangledToolName(`${name}(${key}="${value}")`)).toEqual({ name, input: { [key]: value } });
      }),
    );
  });
});
