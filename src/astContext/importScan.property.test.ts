import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { findBlockEnd, findIndentEnd, resolveImportPath } from './importScan.js';

// Property-based tests for the pure line/import scanners. The key invariants are
// range-safety (the scanners never return an out-of-range index or throw on any
// input) and, for path resolution, that `.`/`..` segments from the specifier are
// always consumed.

const anyLines = fc.array(fc.string(), { minLength: 1, maxLength: 30 });

describe('findBlockEnd — properties', () => {
  it('returns an index within [start, lines.length-1] and never throws', () => {
    fc.assert(
      fc.property(anyLines, fc.nat(), (lines, startRaw) => {
        const start = startRaw % lines.length;
        const r = findBlockEnd(lines, start);
        expect(r).toBeGreaterThanOrEqual(start);
        expect(r).toBeLessThanOrEqual(lines.length - 1);
      }),
    );
  });
});

describe('findIndentEnd — properties', () => {
  it('returns an index within [start, lines.length-1] and never throws', () => {
    fc.assert(
      fc.property(anyLines, fc.nat(), (lines, startRaw) => {
        const start = startRaw % lines.length;
        const r = findIndentEnd(lines, start);
        expect(r).toBeGreaterThanOrEqual(start);
        expect(r).toBeLessThanOrEqual(lines.length - 1);
      }),
    );
  });
});

describe('resolveImportPath — properties', () => {
  it('is total: never throws for any importer/specifier pair', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (imp, spec) => {
        resolveImportPath(imp, spec);
      }),
    );
  });

  it('returns null for any non-relative (non-dot-prefixed) specifier', () => {
    const nonRelative = fc.string().filter((s) => !s.startsWith('.'));
    fc.assert(
      fc.property(fc.string(), nonRelative, (imp, spec) => {
        expect(resolveImportPath(imp, spec)).toBeNull();
      }),
    );
  });

  it('consumes `.`/`..` from the specifier — the output has no dot segments', () => {
    // Use a clean importer path (no `.`/`..` segments of its own) so any dot
    // segment in the output could only have come from the — always-consumed —
    // specifier.
    const cleanDir = fc.array(fc.stringMatching(/^[a-z]+$/), { minLength: 0, maxLength: 5 });
    const relSpec = fc
      .array(fc.stringMatching(/^(\.|\.\.|[a-z]+)$/), { minLength: 1, maxLength: 6 })
      .map((segs) => './' + segs.join('/'));
    fc.assert(
      fc.property(cleanDir, relSpec, (dirSegs, spec) => {
        const importer = [...dirSegs, 'file.ts'].join('/');
        const r = resolveImportPath(importer, spec);
        if (r !== null && r !== '') {
          const segs = r.split('/');
          expect(segs).not.toContain('.');
          expect(segs).not.toContain('..');
        }
      }),
    );
  });
});
