import { describe, it, expect } from 'vitest';
import { applyContextRules, matchGlob, StructuredContextRules } from './structuredContextRules.js';

describe('matchGlob', () => {
  it('matches exact paths', () => {
    expect(matchGlob('src/index.ts', 'src/index.ts')).toBe(true);
    expect(matchGlob('src/index.ts', 'src/other.ts')).toBe(false);
  });

  it('matches single-segment wildcards', () => {
    expect(matchGlob('src/*.ts', 'src/index.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/deep/index.ts')).toBe(false);
  });

  it('matches double-star across segments', () => {
    expect(matchGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(matchGlob('**/*.test.ts', 'src/utils/foo.test.ts')).toBe(true);
    expect(matchGlob('**/*.test.ts', 'src/utils/foo.ts')).toBe(false);
  });

  it('matches ? as single character', () => {
    expect(matchGlob('src/?.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/?.ts', 'src/ab.ts')).toBe(false);
  });
});

// Helper to make scored file objects
function file(relativePath: string, score = 0.5) {
  return { relativePath, score };
}

describe('applyContextRules', () => {
  it('returns files unchanged when no rules exist', () => {
    const files = [file('a.ts'), file('b.ts')];
    const result = applyContextRules(files, { rules: [] });
    expect(result).toEqual(files);
  });

  it('prefer rule boosts matching files', () => {
    const files = [file('src/components/Button.tsx', 0.2), file('src/utils/math.ts', 0.2)];
    const rules: StructuredContextRules = {
      rules: [{ type: 'prefer', pattern: 'src/components/**' }],
    };
    applyContextRules(files, rules);
    expect(files[0].score).toBeCloseTo(0.5); // 0.2 + 0.3 default boost
    expect(files[1].score).toBeCloseTo(0.2); // unchanged
  });

  it('prefer rule uses custom boost value', () => {
    const files = [file('src/api/handler.ts', 0.1)];
    const rules: StructuredContextRules = {
      rules: [{ type: 'prefer', pattern: 'src/api/**', boost: 0.5 }],
    };
    applyContextRules(files, rules);
    expect(files[0].score).toBeCloseTo(0.6);
  });

  it('ban rule removes matching files', () => {
    const files = [file('src/app.ts'), file('src/app.generated.ts'), file('dist/bundle.js')];
    const rules: StructuredContextRules = {
      rules: [{ type: 'ban', pattern: '**/*.generated.*' }],
    };
    const result = applyContextRules(files, rules);
    expect(result.map((f) => f.relativePath)).toEqual(['src/app.ts', 'dist/bundle.js']);
  });

  it('require rule gives minimum score to zero-scored matches', () => {
    const files = [file('src/app.ts', 0.5), file('src/app.test.ts', 0)];
    const rules: StructuredContextRules = {
      rules: [{ type: 'require', pattern: '**/*.test.*' }],
    };
    applyContextRules(files, rules);
    expect(files[1].score).toBeGreaterThan(0); // rescued from 0
    expect(files[0].score).toBe(0.5); // unchanged
  });

  it('require rule does not downgrade already-scored files', () => {
    const files = [file('src/app.test.ts', 0.8)];
    const rules: StructuredContextRules = {
      rules: [{ type: 'require', pattern: '**/*.test.*' }],
    };
    applyContextRules(files, rules);
    expect(files[0].score).toBe(0.8);
  });

  it('applies multiple rules in order', () => {
    const files = [
      file('src/components/Button.tsx', 0.2),
      file('src/generated/types.ts', 0.4),
      file('src/utils.test.ts', 0),
    ];
    const rules: StructuredContextRules = {
      rules: [
        { type: 'prefer', pattern: 'src/components/**' },
        { type: 'ban', pattern: 'src/generated/**' },
        { type: 'require', pattern: '**/*.test.*' },
      ],
    };
    const result = applyContextRules(files, rules);
    expect(result.map((f) => f.relativePath)).toEqual(['src/components/Button.tsx', 'src/utils.test.ts']);
    expect(result[0].score).toBeCloseTo(0.5); // boosted
    expect(result[1].score).toBeGreaterThan(0); // rescued
  });
});
