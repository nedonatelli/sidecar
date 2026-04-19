import { describe, it, expect } from 'vitest';
import { parseSidecarMd, pathMatchesAnyGlob, selectSidecarMdSections } from './sidecarMdParser.js';

// ---------------------------------------------------------------------------
// Tests for sidecarMdParser.ts (v0.67 chunk 1).
//
// Split into three groups: (1) parser output correctness, (2) glob
// matching edge cases, (3) selector priority + budget behavior.
// ---------------------------------------------------------------------------

describe('parseSidecarMd — preamble handling', () => {
  it('returns empty preamble + zero sections for empty input', () => {
    const parsed = parseSidecarMd('');
    expect(parsed.preamble).toBe('');
    expect(parsed.sections).toEqual([]);
    expect(parsed.hasAnyPathSentinel).toBe(false);
  });

  it('captures content before the first H2 as the preamble', () => {
    const parsed = parseSidecarMd(
      ['# Project: SideCar', '', 'Top-of-file notes', '', '## Build', '- Run tests with `npm test`'].join('\n'),
    );
    expect(parsed.preamble).toContain('# Project: SideCar');
    expect(parsed.preamble).toContain('Top-of-file notes');
    expect(parsed.preamble).not.toContain('## Build');
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].heading).toBe('Build');
  });

  it('treats a file with no H2 headings as pure preamble', () => {
    const parsed = parseSidecarMd('Just prose, no headings.\n- And a list');
    expect(parsed.preamble).toContain('Just prose');
    expect(parsed.sections).toEqual([]);
  });
});

describe('parseSidecarMd — section boundaries', () => {
  it('splits on H2 and preserves the heading line in the body', () => {
    const parsed = parseSidecarMd(['## Build', 'line-A', '', '## Conventions', 'line-B'].join('\n'));
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0].heading).toBe('Build');
    expect(parsed.sections[0].body).toContain('## Build');
    expect(parsed.sections[0].body).toContain('line-A');
    expect(parsed.sections[0].body).not.toContain('line-B');
    expect(parsed.sections[1].heading).toBe('Conventions');
  });

  it('treats H3 as a section boundary too', () => {
    const parsed = parseSidecarMd('### Subsection\nbody');
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].heading).toBe('Subsection');
  });

  it('leaves H4+ inside the containing section body', () => {
    const parsed = parseSidecarMd(['## Outer', '#### Deeper heading', 'body'].join('\n'));
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].body).toContain('#### Deeper heading');
  });
});

describe('parseSidecarMd — @paths sentinel', () => {
  it('extracts comma-separated path globs from the sentinel comment', () => {
    const parsed = parseSidecarMd(
      ['## Transforms', '<!-- @paths: src/transforms/**, src/dsp/** -->', 'Filter kernels belong here'].join('\n'),
    );
    expect(parsed.sections[0].paths).toEqual(['src/transforms/**', 'src/dsp/**']);
    expect(parsed.sections[0].priority).toBe('scoped');
    expect(parsed.hasAnyPathSentinel).toBe(true);
  });

  it('assigns priority "always" when no sentinel is present', () => {
    const parsed = parseSidecarMd('## Build\n- Run tests');
    expect(parsed.sections[0].priority).toBe('always');
    expect(parsed.sections[0].paths).toEqual([]);
    expect(parsed.hasAnyPathSentinel).toBe(false);
  });

  it('allows a blank line between heading and sentinel', () => {
    const parsed = parseSidecarMd(['## Transforms', '', '<!-- @paths: src/transforms/** -->', 'body'].join('\n'));
    expect(parsed.sections[0].paths).toEqual(['src/transforms/**']);
  });

  it('ignores a malformed sentinel (no paths key)', () => {
    const parsed = parseSidecarMd(['## Notes', '<!-- random comment -->', 'body'].join('\n'));
    expect(parsed.sections[0].paths).toEqual([]);
    expect(parsed.sections[0].priority).toBe('always');
  });
});

describe('pathMatchesAnyGlob', () => {
  it('returns false for an empty glob list', () => {
    expect(pathMatchesAnyGlob('src/foo.ts', [])).toBe(false);
  });

  it('matches a `**` glob against any depth', () => {
    expect(pathMatchesAnyGlob('src/a/b/c.ts', ['src/**'])).toBe(true);
    expect(pathMatchesAnyGlob('src/a.ts', ['src/**'])).toBe(true);
    expect(pathMatchesAnyGlob('src', ['src/**'])).toBe(false); // bare dir without trailing slash
  });

  it('matches a `*` glob against a single path segment', () => {
    expect(pathMatchesAnyGlob('src/foo.ts', ['src/*.ts'])).toBe(true);
    expect(pathMatchesAnyGlob('src/sub/foo.ts', ['src/*.ts'])).toBe(false);
  });

  it('treats a trailing slash as "/**"', () => {
    expect(pathMatchesAnyGlob('src/transforms/fft.ts', ['src/transforms/'])).toBe(true);
    expect(pathMatchesAnyGlob('src/unrelated.ts', ['src/transforms/'])).toBe(false);
  });

  it('handles Windows back-slashes', () => {
    expect(pathMatchesAnyGlob('src\\foo\\bar.ts', ['src/**'])).toBe(true);
  });

  it('tries every glob in the list and succeeds on any match', () => {
    expect(pathMatchesAnyGlob('tests/unit.test.ts', ['src/**', 'tests/**'])).toBe(true);
  });

  it('escapes regex metacharacters in literal path segments', () => {
    // `transform.plus` must match literally, not as "transform" + "any-char"
    expect(pathMatchesAnyGlob('src/transform.plus.ts', ['src/transform.plus.ts'])).toBe(true);
    expect(pathMatchesAnyGlob('src/transformXplus.ts', ['src/transform.plus.ts'])).toBe(false);
  });
});

// Fixture helper — builds a typical SIDECAR.md with a preamble + three
// H2 sections, one of which is path-scoped.
function fixture(): string {
  return [
    '# Project: SideCar',
    '',
    'Project-wide notes live in the preamble.',
    '',
    '## Build',
    '- Run `npm test`',
    '- Run `npm run lint`',
    '',
    '## Transforms',
    '<!-- @paths: src/transforms/**, src/dsp/** -->',
    'Filter kernels go under src/transforms/.',
    '',
    '## Glossary',
    '- Term: definition',
  ].join('\n');
}

describe('selectSidecarMdSections — always path', () => {
  it('includes every section when the budget is ample and there are no priority rules', () => {
    const parsed = parseSidecarMd(fixture());
    const sel = selectSidecarMdSections(parsed, { maxChars: 10_000 });
    expect(sel.sections.map((s) => s.heading)).toEqual(['Build', 'Glossary']);
    // Transforms (scoped) didn't match any active file, so it's absent
    // from sections but wasn't dropped for budget either.
    expect(sel.droppedForBudget).toEqual([]);
    expect(sel.rendered).toContain('## Build');
    expect(sel.rendered).toContain('## Glossary');
    expect(sel.rendered).not.toContain('## Transforms');
  });

  it('renders the preamble at the top of the output', () => {
    const parsed = parseSidecarMd(fixture());
    const sel = selectSidecarMdSections(parsed, { maxChars: 10_000 });
    const preambleIdx = sel.rendered.indexOf('Project-wide notes');
    const buildIdx = sel.rendered.indexOf('## Build');
    expect(preambleIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(preambleIdx);
  });
});

describe('selectSidecarMdSections — scoped routing', () => {
  it('includes a scoped section when the active file matches its @paths glob', () => {
    const parsed = parseSidecarMd(fixture());
    const sel = selectSidecarMdSections(parsed, {
      activeFilePath: 'src/transforms/fft.ts',
      maxChars: 10_000,
    });
    expect(sel.sections.map((s) => s.heading)).toContain('Transforms');
  });

  it('omits a scoped section when the active file does not match', () => {
    const parsed = parseSidecarMd(fixture());
    const sel = selectSidecarMdSections(parsed, {
      activeFilePath: 'src/ui/button.tsx',
      maxChars: 10_000,
    });
    expect(sel.sections.map((s) => s.heading)).not.toContain('Transforms');
  });

  it('matches against user-mentioned paths when no active editor is available', () => {
    const parsed = parseSidecarMd(fixture());
    const sel = selectSidecarMdSections(parsed, {
      mentionedPaths: ['src/dsp/filter.py'],
      maxChars: 10_000,
    });
    expect(sel.sections.map((s) => s.heading)).toContain('Transforms');
  });

  it('caps scoped inclusions at maxScopedSections', () => {
    const md = [
      '## A',
      '<!-- @paths: src/** -->',
      'a',
      '',
      '## B',
      '<!-- @paths: src/** -->',
      'b',
      '',
      '## C',
      '<!-- @paths: src/** -->',
      'c',
    ].join('\n');
    const parsed = parseSidecarMd(md);
    const sel = selectSidecarMdSections(parsed, {
      activeFilePath: 'src/foo.ts',
      maxScopedSections: 2,
      maxChars: 10_000,
    });
    expect(sel.sections.map((s) => s.heading)).toEqual(['A', 'B']);
  });
});

describe('selectSidecarMdSections — priority overrides', () => {
  it('promotes a section to "always" when its heading matches alwaysIncludeHeadings', () => {
    const parsed = parseSidecarMd(['## Notes', '<!-- @paths: src/** -->', 'body'].join('\n'));
    const sel = selectSidecarMdSections(parsed, {
      alwaysIncludeHeadings: ['Notes'],
      maxChars: 10_000,
    });
    // Even without an active file, the promoted Notes section lands
    // because it's been elevated to 'always'.
    expect(sel.sections.map((s) => s.heading)).toContain('Notes');
  });

  it('demotes a section to "low" when its heading matches lowPriorityHeadings', () => {
    // Build a document where the demotion matters: Always section is
    // ~200 chars, Glossary section is ~100 chars, budget fits only one.
    const md = ['## Build', 'x'.repeat(200), '', '## Glossary', 'y'.repeat(100)].join('\n');
    const parsed = parseSidecarMd(md);
    const sel = selectSidecarMdSections(parsed, {
      lowPriorityHeadings: ['Glossary'],
      maxChars: 250,
    });
    expect(sel.sections.map((s) => s.heading)).toContain('Build');
    expect(sel.sections.map((s) => s.heading)).not.toContain('Glossary');
    expect(sel.droppedForBudget.map((s) => s.heading)).toContain('Glossary');
  });

  it('matches heading-override lists case-insensitively', () => {
    const parsed = parseSidecarMd('## build\nbody');
    const sel = selectSidecarMdSections(parsed, {
      alwaysIncludeHeadings: ['BUILD'],
      maxChars: 10_000,
    });
    expect(sel.sections[0].heading).toBe('build');
  });
});

describe('selectSidecarMdSections — budget enforcement', () => {
  it('drops whole sections in reverse priority order on overflow', () => {
    const md = ['## High', 'x'.repeat(100), '', '## Low-Priority', 'x'.repeat(100)].join('\n');
    const parsed = parseSidecarMd(md);
    const sel = selectSidecarMdSections(parsed, {
      lowPriorityHeadings: ['Low-Priority'],
      maxChars: 150,
    });
    expect(sel.sections.map((s) => s.heading)).toEqual(['High']);
    expect(sel.droppedForBudget.map((s) => s.heading)).toEqual(['Low-Priority']);
  });

  it('never mid-chops a section — returned content is always whole sections', () => {
    const parsed = parseSidecarMd(fixture());
    const sel = selectSidecarMdSections(parsed, { maxChars: 200 });
    // The rendered output should only contain whole sections, never a
    // truncated tail. Verify by parsing the output again and checking
    // every section body matches one in the source.
    const reparsed = parseSidecarMd(sel.rendered);
    for (const s of reparsed.sections) {
      const source = parsed.sections.find((p) => p.heading === s.heading);
      expect(source).toBeDefined();
      expect(s.body).toBe(source?.body);
    }
  });
});
