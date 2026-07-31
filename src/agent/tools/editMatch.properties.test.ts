import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { findEditMatch, detectEol, applyEol } from './editMatch.js';

// GREYBOX — properties of the edit matcher over generated input.
//
// Enumerated tests assert values a human thought of. These assert invariants
// that must hold for input nobody enumerated, which is the only way to cover a
// space as awkward as "arbitrary text with arbitrary line endings". Each
// property below is stated from the SPEC, not from the implementation — a test
// derived from the code would have inherited the same LF assumption that made
// CRLF invisible for months.
//
// Shrinking is the real payoff: a counterexample arrives minimized, so a
// failure names the smallest input that breaks the rule.

/** Line content that cannot itself contain a line break or `$`-noise ambiguity. */
const lineArb = fc.stringMatching(/^[a-zA-Z0-9 _(){};=.,:+*/-]{0,24}$/);

/** A document plus the ending it is written with. */
const docArb = fc
  .record({
    lines: fc.array(lineArb, { minLength: 2, maxLength: 8 }),
    eol: fc.constantFrom('\n', '\r\n', '\r'),
    trailingNewline: fc.boolean(),
  })
  .map(({ lines, eol, trailingNewline }) => ({
    text: lines.join(eol) + (trailingNewline ? eol : ''),
    lines,
    eol,
  }));

/** Splice a match the way resolveEditedText does. */
const applyMatch = (text: string, search: string, replace: string): string | null => {
  const m = findEditMatch(text, search, replace);
  return m === null ? null : text.slice(0, m.start) + m.replacement + text.slice(m.end);
};

describe('edit matcher properties', () => {
  it('SELF-SEARCH: any span of the file, re-emitted with LF, is findable', () => {
    // The CRLF bug in one sentence. A model reads a file and reproduces part of
    // it using LF; that text must resolve back to the region it came from.
    fc.assert(
      fc.property(docArb, fc.nat(), fc.nat(), ({ text, lines, eol }, i, len) => {
        const start = lines.length === 0 ? 0 : i % lines.length;
        const count = 1 + (len % Math.max(1, lines.length - start));
        const span = lines.slice(start, start + count);
        fc.pre(span.every((l) => l.trim() !== ''));
        fc.pre(new Set(lines.map((l) => l.trim())).size === lines.length); // unique → unambiguous

        const search = span.join('\n'); // what the model emits
        const m = findEditMatch(text, search, search);
        expect(m).not.toBeNull();
        expect(text.slice(m!.start, m!.end)).toBe(span.join(eol));
      }),
      { numRuns: 400 },
    );
  });

  it('IDENTITY: replacing a span with itself reproduces the file byte-for-byte', () => {
    // Catches EOL rewriting, $-expansion and span arithmetic in one property.
    fc.assert(
      fc.property(docArb, fc.nat(), ({ text, lines, eol }, i) => {
        const idx = lines.length === 0 ? 0 : i % lines.length;
        const line = lines[idx];
        fc.pre(line.trim() !== '');
        fc.pre(lines.filter((l) => l === line).length === 1);

        // The replacement is the file's own text for that span, so the result
        // must be the original file — whatever the line endings are.
        const out = applyMatch(text, line, applyEol(line, eol));
        expect(out).toBe(text);
      }),
      { numRuns: 400 },
    );
  });

  it('LOCALITY: bytes outside the matched span are never touched', () => {
    fc.assert(
      fc.property(docArb, fc.nat(), fc.string(), ({ text, lines }, i, replacement) => {
        const idx = lines.length === 0 ? 0 : i % lines.length;
        const line = lines[idx];
        fc.pre(line.trim() !== '');
        fc.pre(lines.filter((l) => l === line).length === 1);

        const m = findEditMatch(text, line, replacement);
        fc.pre(m !== null);
        const out = text.slice(0, m!.start) + m!.replacement + text.slice(m!.end);
        expect(out.startsWith(text.slice(0, m!.start))).toBe(true);
        expect(out.endsWith(text.slice(m!.end))).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('CONVENTION: a uniform file keeps its line endings through any replacement', () => {
    fc.assert(
      fc.property(
        docArb,
        fc.nat(),
        fc.array(lineArb, { minLength: 1, maxLength: 4 }),
        ({ text, lines, eol }, i, rep) => {
          const idx = lines.length === 0 ? 0 : i % lines.length;
          const line = lines[idx];
          fc.pre(line.trim() !== '');
          fc.pre(lines.filter((l) => l === line).length === 1);
          fc.pre(detectEol(text).uniform);

          // The model always writes LF; the file's convention must survive.
          const out = applyMatch(text, line, rep.join('\n'));
          fc.pre(out !== null);
          expect(detectEol(out!).eol).toBe(eol);
          if (eol === '\r\n') {
            expect(/[^\r]\n/.test(out!)).toBe(false);
            // A doubled `\r` also survives the check above — `\r\r\n` has no
            // non-`\r` before its `\n`. A span opening between the halves of a
            // CRLF pair produced exactly that, and this property passed over it.
            expect(/\r\r/.test(out!)).toBe(false);
          }
          if (eol === '\r') expect(out!.includes('\n')).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('LITERAL REPLACEMENT: $-sequences are never expanded', () => {
    fc.assert(
      fc.property(
        docArb,
        fc.nat(),
        fc.constantFrom('$&', "$'", '$`', '$1', '$$', 'pre $& post'),
        ({ text, lines }, i, dollar) => {
          const idx = lines.length === 0 ? 0 : i % lines.length;
          const line = lines[idx];
          fc.pre(line.trim() !== '');
          fc.pre(lines.filter((l) => l === line).length === 1);

          const m = findEditMatch(text, line, dollar);
          fc.pre(m !== null);
          expect(m!.replacement).toBe(dollar);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('AMBIGUITY: a search matching N regions reports N, never picks one silently', () => {
    fc.assert(
      fc.property(lineArb, fc.integer({ min: 2, max: 5 }), fc.constantFrom('\n', '\r\n'), (line, n, eol) => {
        fc.pre(line.trim() !== '');
        const text = Array.from({ length: n }, () => line).join(eol) + eol;
        const m = findEditMatch(text, line, 'replacement');
        expect(m).not.toBeNull();
        expect(m!.count).toBe(n);
      }),
      { numRuns: 200 },
    );
  });
});
