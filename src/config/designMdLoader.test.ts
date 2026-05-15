import { describe, it, expect } from 'vitest';
import { parseDesignMd, renderDesignMdContext, isUiFile } from './designMdLoader.js';

const SAMPLE = `---
name: Heritage
colors:
  primary: "#1A1C1E"
  secondary: "#6C7278"
  tertiary: "#B8422E"
  neutral: "#F7F5F2"
typography:
  h1:
    fontFamily: Public Sans
    fontSize: 3rem
spacing:
  sm: 8px
  md: 16px
---

## Overview

Architectural minimalism meets journalistic gravitas.

## Colors

The palette is rooted in high-contrast neutrals.
`;

describe('parseDesignMd', () => {
  it('splits frontmatter and body', () => {
    const { frontmatter, body } = parseDesignMd(SAMPLE);
    expect(frontmatter).toContain('primary: "#1A1C1E"');
    expect(frontmatter).not.toContain('---');
    expect(body).toContain('## Overview');
    expect(body).not.toContain('---');
  });

  it('returns null frontmatter when no fences', () => {
    const { frontmatter, body } = parseDesignMd('# Just a markdown file\n\nNo tokens here.');
    expect(frontmatter).toBeNull();
    expect(body).toContain('No tokens here');
  });

  it('returns null frontmatter when opening fence has no closing fence', () => {
    const { frontmatter } = parseDesignMd('---\nname: Broken\n# No closing fence');
    expect(frontmatter).toBeNull();
  });

  it('handles empty frontmatter block', () => {
    const { frontmatter } = parseDesignMd('---\n---\n\n## Body');
    expect(frontmatter).toBeNull();
  });
});

describe('isUiFile', () => {
  it.each(['.css', '.scss', '.less', '.tsx', '.jsx', '.svelte', '.vue', '.astro', '.html', '.htm'])(
    'returns true for %s',
    (ext) => {
      expect(isUiFile(`src/components/Button${ext}`)).toBe(true);
    },
  );

  it.each(['.ts', '.js', '.py', '.go', '.md', '.json'])('returns false for %s', (ext) => {
    expect(isUiFile(`src/utils/helper${ext}`)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isUiFile(undefined)).toBe(false);
  });
});

describe('renderDesignMdContext', () => {
  it('always includes the tokens block', () => {
    const result = renderDesignMdContext(SAMPLE, { maxChars: 10_000 });
    expect(result).toContain('<design_tokens source="DESIGN.md">');
    expect(result).toContain('primary: "#1A1C1E"');
    expect(result).toContain('</design_tokens>');
  });

  it('includes prose body for a UI file', () => {
    const result = renderDesignMdContext(SAMPLE, {
      activeFilePath: 'src/components/Button.tsx',
      maxChars: 10_000,
    });
    expect(result).toContain('## Overview');
    expect(result).toContain('## Colors');
  });

  it('omits prose body for a non-UI file', () => {
    const result = renderDesignMdContext(SAMPLE, {
      activeFilePath: 'src/utils/math.ts',
      maxChars: 10_000,
    });
    expect(result).toContain('<design_tokens');
    expect(result).not.toContain('## Overview');
  });

  it('omits prose body when no active file', () => {
    const result = renderDesignMdContext(SAMPLE, { maxChars: 10_000 });
    expect(result).not.toContain('## Overview');
  });

  it('truncates when over maxChars', () => {
    const result = renderDesignMdContext(SAMPLE, { maxChars: 50 });
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('returns empty string for blank content', () => {
    expect(renderDesignMdContext('', { maxChars: 1000 })).toBe('');
    expect(renderDesignMdContext('   ', { maxChars: 1000 })).toBe('');
  });

  it('injects body-only files (no frontmatter) regardless of active file', () => {
    const bodyOnly = '## Guidelines\n\nUse 8px grid.';
    const result = renderDesignMdContext(bodyOnly, { maxChars: 1000 });
    expect(result).toContain('## Guidelines');
    expect(result).not.toContain('<design_tokens');
  });
});
