import { describe, it, expect } from 'vitest';
import { synthesizeFacetReviews, type FacetReviewResult } from './facetSynthesis.js';

function r(facetId: string, output: string, over: Partial<FacetReviewResult> = {}): FacetReviewResult {
  return { facetId, output, success: true, hasDiff: false, ...over };
}

describe('synthesizeFacetReviews', () => {
  it('uses the single-review heading for one result', () => {
    const md = synthesizeFacetReviews('review it', [r('architecture-reviewer', 'Strengths: modular.')]);
    expect(md).toContain('# architecture-reviewer — review');
    expect(md).toContain('_Task: review it_');
    expect(md).toContain('Strengths: modular.');
    expect(md).not.toContain('## ');
  });

  it('concatenates multiple results under per-facet sections', () => {
    const md = synthesizeFacetReviews('full review', [
      r('architecture-reviewer', 'Arch findings.'),
      r('security-reviewer', 'Security findings.'),
    ]);
    expect(md).toContain('# Comprehensive review');
    expect(md).toContain('## architecture-reviewer');
    expect(md).toContain('Arch findings.');
    expect(md).toContain('## security-reviewer');
    expect(md).toContain('Security findings.');
  });

  it('drops failed, diff-producing, and empty results', () => {
    const md = synthesizeFacetReviews('x', [
      r('architecture-reviewer', 'good'),
      r('general-coder', 'a diff', { hasDiff: true }),
      r('test-author', 'failed', { success: false }),
      r('security-reviewer', '(facet produced no output)'),
    ]);
    // Only architecture-reviewer is usable → single-review form, no sections.
    expect(md).toContain('# architecture-reviewer — review');
    expect(md).not.toContain('general-coder');
    expect(md).not.toContain('test-author');
    expect(md).not.toContain('security-reviewer');
  });

  it('returns empty when nothing is usable', () => {
    expect(synthesizeFacetReviews('x', [r('a', '', { output: '' })])).toBe('');
    expect(synthesizeFacetReviews('x', [])).toBe('');
  });
});
