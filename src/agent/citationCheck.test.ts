import { describe, it, expect } from 'vitest';
import { extractCitedPaths, pathVariants, hasUnverifiedHedge } from './citationCheck.js';

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
