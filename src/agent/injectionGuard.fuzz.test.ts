import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { detectInjection, fenceContent, neutralizeInjections } from './injectionGuard.js';

// Fuzz suite for the injection guard — it scans UNTRUSTED tool/web output for
// prompt-injection patterns and fences it before the content re-enters the
// model context. A crash or hang here is a reliability + security risk, so these
// assert totality (no throw) and the basic output contracts on arbitrary input.

describe('injectionGuard — fuzz (untrusted tool output)', () => {
  it('detectInjection never throws and always returns an array', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(Array.isArray(detectInjection(s))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('detectInjection never throws on full-unicode input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        detectInjection(s);
      }),
      { numRuns: 500 },
    );
  });

  it('detectInjection never throws on injection-phrase soup', () => {
    // Fragments crafted to hit the detector patterns in adversarial combinations.
    const frag = fc.constantFrom(
      'ignore previous instructions',
      'system:',
      'you are now',
      'disregard',
      'new instructions',
      '</tool_output>',
      '<system>',
      'IMPORTANT:',
      'assistant:',
      '\n\n',
      'do not tell the user',
      'run this command',
      '```',
      'override',
    );
    const soup = fc.array(frag, { maxLength: 40 }).map((a) => a.join(' '));
    fc.assert(
      fc.property(soup, (s) => {
        detectInjection(s);
      }),
      { numRuns: 1000 },
    );
  });

  it('fenceContent never throws and returns a string for any content/label', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (content, label) => {
        expect(typeof fenceContent(content, label)).toBe('string');
      }),
      { numRuns: 500 },
    );
  });

  it('neutralizeInjections never throws and returns a string content field', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (content, label) => {
        const r = neutralizeInjections(content, label);
        expect(typeof r.text).toBe('string');
      }),
      { numRuns: 500 },
    );
  });
});
