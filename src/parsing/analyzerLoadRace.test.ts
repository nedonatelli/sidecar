import { describe, it, expect } from 'vitest';
import { getAnalyzer, setGrammarsPath } from './registry.js';
import { grammarsDir, hasGrammars } from './grammarsTestSupport.js';

// The symbol indexer calls getAnalyzer CONCURRENTLY for every file in the
// workspace (`Promise.allSettled` over ~1000 files). The registry gated its
// tree-sitter load on a boolean that flipped the instant the first caller
// arrived, while the analyzer it gates on is not assigned until grammar loading
// finishes. So every caller after the first skipped the load block, found the
// analyzer still null, and silently took the regex fallback.
//
// The grammars loaded correctly the whole time — into a variable nobody was
// waiting on. Measured in a real install: the SideCar log showed grammars
// loading at 13:51:15 while the graph written at that same second contained 6
// `method` symbols against tree-sitter's 1487, and matched the regex analyzer
// on every other kind.
//
// A sequential call always worked, which is why every direct test of
// createTreeSitterAnalyzer passed throughout. Only concurrency exposes it.

describe.skipIf(!hasGrammars)('concurrent getAnalyzer', () => {
  it('gives every concurrent caller the tree-sitter analyzer, not just the first', async () => {
    setGrammarsPath(grammarsDir);

    // The shape the indexer actually produces: many callers in flight before
    // the first load resolves. One or two would not reproduce it.
    const analyzers = await Promise.all(Array.from({ length: 50 }, () => getAnalyzer('ts')));

    const names = analyzers.map((a) => a.constructor.name);
    const regexCount = names.filter((n) => n === 'RegexAnalyzer').length;

    expect(regexCount, `${regexCount} of ${names.length} concurrent callers fell back to regex`).toBe(0);
    // All callers must receive the SAME instance — a per-caller load would mean
    // 50 grammar loads, which is its own defect.
    expect(new Set(analyzers).size).toBe(1);
  }, 120000);

  it('extracts method symbols, which the regex analyzer never emits', () => {
    // The categorical discriminator. Counting functions or classes means
    // squinting at two similar numbers; the regex analyzer emits zero methods,
    // so their presence is proof of which parser ran.
    return getAnalyzer('ts').then((a) => {
      const els =
        (
          a.parseFileContent('probe.ts', 'export class K { m(): void {} }\n') as {
            elements?: Array<{ name: string; type: string }>;
          }
        )?.elements ?? [];
      expect(els.some((e) => e.type === 'method' && e.name === 'm')).toBe(true);
    });
  });
});
