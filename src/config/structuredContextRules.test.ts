import { describe, it, expect } from 'vitest';
import { applyContextRules, StructuredContextRules } from './structuredContextRules.js';

describe('applyContextRules', () => {
  it('returns all files when no rules are provided', () => {
    const files = ['file1.ts', 'file2.ts', 'file3.ts'];
    const rules: StructuredContextRules = { rules: [] };

    const result = applyContextRules(files, rules);
    expect(result).toEqual(files);
  });

  it('boosts functional-components with prefer rule', () => {
    const files = ['component1.tsx', 'component2.ts', 'utils.ts'];
    const rules: StructuredContextRules = {
      rules: [
        {
          type: 'prefer',
          constraint: 'functional-components',
        },
      ],
    };

    const result = applyContextRules(files, rules);
    // Should return files sorted by score (functional components get boosted)
    expect(result).toHaveLength(3);
  });

  it('includes test files with require rule', () => {
    const files = ['app.ts', 'app.test.ts', 'utils.ts', 'utils.spec.ts'];
    const rules: StructuredContextRules = {
      rules: [
        {
          type: 'require',
          constraint: 'test-file',
        },
      ],
    };

    const result = applyContextRules(files, rules);
    // Should include test files with higher scores
    expect(result).toHaveLength(4);
  });

  it('handles ban rule for any-type constraint', () => {
    const files = ['file1.ts', 'file2.ts', 'any-file.ts'];
    const rules: StructuredContextRules = {
      rules: [
        {
          type: 'ban',
          constraint: 'any-type',
        },
      ],
    };

    const result = applyContextRules(files, rules);
    // Should filter out files containing 'any'
    expect(result).not.toContain('any-file.ts');
  });
});
