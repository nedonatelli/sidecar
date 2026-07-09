import { describe, it, expect } from 'vitest';
import {
  extractCitedPaths,
  pathVariants,
  hasUnverifiedHedge,
  resolvesAmong,
  citationMetricsForText,
  type CitationMetrics,
} from './citationCheck.js';

describe('extractCitedPaths', () => {
  it('extracts workspace-rooted and extension-bearing paths', () => {
    const text = 'The loop in `src/agent/loop.ts` calls into `messageBuild.js` and reads package.json.';
    expect(extractCitedPaths(text)).toEqual(['src/agent/loop.ts', 'messageBuild.js', 'package.json']);
  });

  it('dedupes repeated citations', () => {
    expect(extractCitedPaths('see src/a.ts and again src/a.ts')).toEqual(['src/a.ts']);
  });

  it('does not match a glob or a bare directory', () => {
    expect(extractCitedPaths('files under src/agent/ matching src/**/*.ts')).toEqual([]);
  });

  it('returns empty for prose with no paths', () => {
    expect(extractCitedPaths('The architecture is sound and modular.')).toEqual([]);
  });
});

describe('pathVariants', () => {
  it('maps a .js citation to its .ts sibling (NodeNext)', () => {
    expect(pathVariants('src/agent/loop/messageBuild.js')).toEqual([
      'src/agent/loop/messageBuild.js',
      'src/agent/loop/messageBuild.ts',
    ]);
  });

  it('maps .jsx to .tsx', () => {
    expect(pathVariants('ui/Button.jsx')).toEqual(['ui/Button.jsx', 'ui/Button.tsx']);
  });

  it('leaves a .ts path unchanged', () => {
    expect(pathVariants('src/agent/loop.ts')).toEqual(['src/agent/loop.ts']);
  });
});

describe('hasUnverifiedHedge', () => {
  it('flags explicit non-verification admissions', () => {
    expect(hasUnverifiedHedge('though I cannot verify the call site')).toBe(true);
    expect(hasUnverifiedHedge('implied usage in scheduler.ts')).toBe(true);
    expect(hasUnverifiedHedge('I did not read the other files')).toBe(true);
  });

  it('does not flag a confident, grounded statement', () => {
    expect(hasUnverifiedHedge('The runAgentLoop function cleans up in a finally block.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Golden fixtures for the graded citation instrument (M1/M2).
//
// Three instrument bugs each produced a confidently wrong number before a
// live run exposed it: binary pass/fail can't see a reduction, a raw count
// confuses verbosity with fabrication, and exact-at-root resolution counted
// every basename mention as a fabrication (0.85 "rate" in BOTH ablation
// arms). These fixtures have KNOWN ground truth, so each layer of the stack
// is pinned against exactly those failure modes.
// ---------------------------------------------------------------------------

describe('citation instrument — golden fixtures', () => {
  const WORKSPACE = [
    'package.json',
    'README.md',
    'src/index.ts',
    'src/config/settings.ts',
    'src/agent/loop.ts',
    'src/agent/tools.ts',
    'src/index.test.ts',
  ];

  it('resolvesAmong: full path, basename, partial path, and NodeNext variant all resolve', () => {
    expect(resolvesAmong('src/agent/loop.ts', WORKSPACE)).toBe(true); // full
    expect(resolvesAmong('loop.ts', WORKSPACE)).toBe(true); // basename
    expect(resolvesAmong('config/settings.ts', WORKSPACE)).toBe(true); // partial
    expect(resolvesAmong('agent/loop.js', WORKSPACE)).toBe(true); // NodeNext .js → .ts
  });

  it('resolvesAmong: true fabrications match nothing', () => {
    expect(resolvesAmong('src/context/context.ts', WORKSPACE)).toBe(false);
    expect(resolvesAmong('resolveToolOutput.ts', WORKSPACE)).toBe(false);
    // Suffix alignment is /-anchored: "oop.ts" must not match "loop.ts".
    expect(resolvesAmong('oop.ts', WORKSPACE)).toBe(false);
  });

  it('golden: known counts on a mixed review (3 real citation forms + 2 fabrications)', () => {
    const text =
      'The entry point `src/index.ts` wires `settings.ts` and `agent/loop.ts` together. ' +
      'Error handling lives in `src/agent/errorHub.ts` and retries in `backoff.ts`.';
    const m = citationMetricsForText(text, WORKSPACE);
    expect(m.citedPaths).toBe(5);
    expect(m.unresolvedCitations).toBe(2); // errorHub.ts + backoff.ts only
    expect(m.unresolvedCitationRate).toBeCloseTo(2 / 5, 10);
  });

  it('golden: verbosity changes the count but NOT the rate (the count-vs-thoroughness trap)', () => {
    // Same fabrication quality (1 fake per 3 citations); the long review
    // cites twice as much. A count-based comparison would call the longer
    // review "worse"; the rate correctly calls them identical.
    const terse = 'See `src/index.ts` and `loop.ts`; the cache in `cacheLayer.ts` is stale.';
    const verbose =
      'See `src/index.ts` and `loop.ts`; the cache in `cacheLayer.ts` is stale. ' +
      'Also `tools.ts` and `package.json` are fine, but `metricsBus.ts` is unused.';
    const t = citationMetricsForText(terse, WORKSPACE);
    const v = citationMetricsForText(verbose, WORKSPACE);
    expect(t.citedPaths).toBe(3);
    expect(v.citedPaths).toBe(6);
    expect(t.unresolvedCitations).toBe(1);
    expect(v.unresolvedCitations).toBe(2); // count rises with verbosity…
    expect(t.unresolvedCitationRate).toBeCloseTo(v.unresolvedCitationRate, 10); // …rate does not
  });

  it('golden: binary pass/fail is blind to a reduction the graded metrics see', () => {
    // Both texts contain ≥1 fabrication, so a perfection-or-fail scorer
    // fails BOTH (lift uncomputable) — while the rate halves.
    const worse = 'Modules: `src/index.ts`, `ghostA.ts`, `ghostB.ts`, `ghostC.ts`.'; // 3/4 fake
    const better = 'Modules: `src/index.ts`, `loop.ts`, `tools.ts`, `ghostA.ts`.'; // 1/4 fake
    const w = citationMetricsForText(worse, WORKSPACE);
    const b = citationMetricsForText(better, WORKSPACE);
    const binaryPass = (m: CitationMetrics) => m.unresolvedCitations === 0;
    expect(binaryPass(w)).toBe(false);
    expect(binaryPass(b)).toBe(false); // binary: identical verdicts…
    expect(w.unresolvedCitationRate).toBeCloseTo(0.75, 10);
    expect(b.unresolvedCitationRate).toBeCloseTo(0.25, 10); // …graded: 3× reduction
  });

  it('golden: duplicate citations of the same path count once', () => {
    const text = '`loop.ts` calls into `loop.ts` again via `loop.ts`. Also `phantom.ts`.';
    const m = citationMetricsForText(text, WORKSPACE);
    expect(m.citedPaths).toBe(2);
    expect(m.unresolvedCitations).toBe(1);
  });

  it('golden: a text with no citations has rate 0, not NaN', () => {
    const m = citationMetricsForText('The architecture is sound and the tests are thorough.', WORKSPACE);
    expect(m.citedPaths).toBe(0);
    expect(m.unresolvedCitations).toBe(0);
    expect(m.unresolvedCitationRate).toBe(0);
  });
});

describe('citation extractor — prose-noise golden fixtures', () => {
  it('does not extract brand tokens as citations (Node.js prose trap)', () => {
    const prose = 'This Node.js project could use Vue.js or D3.js on the frontend; Express.js serves it.';
    expect(extractCitedPaths(prose)).toEqual([]);
  });

  it('still extracts a real file named like a brand when directory-qualified', () => {
    expect(extractCitedPaths('The shim in `src/node.js` wraps the runtime.')).toEqual(['src/node.js']);
  });

  it('extracts dotted filenames in full, not truncated to the last segments', () => {
    // The earlier pattern turned "vitest.config.ts" into "config.ts" — a
    // token that resolves nowhere and counted as a fabrication.
    expect(extractCitedPaths('Configured in vitest.config.ts and tsconfig.build.json.')).toEqual([
      'vitest.config.ts',
      'tsconfig.build.json',
    ]);
  });

  it('golden: brand-heavy thorough review scores the same rate as a terse one', () => {
    const files = ['src/index.ts', 'src/agent/loop.ts', 'package.json'];
    const terse = '`src/index.ts` wires `loop.ts`; `ghost.ts` is cited wrongly.';
    const thorough =
      'This Node.js codebase centers on `src/index.ts`, which wires `loop.ts` per `package.json`. ' +
      'Like most Vue.js-adjacent stacks it avoids D3.js. `ghost.ts` is cited wrongly.';
    const t = citationMetricsForText(terse, files);
    const th = citationMetricsForText(thorough, files);
    expect(t.unresolvedCitationRate).toBeCloseTo(1 / 3, 10);
    expect(th.unresolvedCitationRate).toBeCloseTo(1 / 4, 10); // one extra REAL citation, zero brand noise
    expect(th.citedPaths).toBe(4);
  });
});
