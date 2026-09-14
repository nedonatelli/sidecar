import { describe, it, expect } from 'vitest';
import {
  validNextVersions,
  latestReleaseTag,
  bumpLandingPage,
  bumpAgentModeDoc,
  bumpTroubleshootingDoc,
  bumpReadme,
  bumpSecurityTable,
  bumpChangelog,
} from './bumpEdits.mjs';

// Snippets are the real shapes from the files, so a drift in the docs breaks
// a test here rather than silently stopping the bump from matching (the README
// pattern once required a literal '+' and never matched; nothing noticed).

describe('version step validation', () => {
  it('allows exactly patch, minor and major steps from the latest tag', () => {
    expect(validNextVersions('v0.123.0')).toEqual(['0.123.1', '0.124.0', '1.0.0']);
    expect(validNextVersions('v1.2.3')).toEqual(['1.2.4', '1.3.0', '2.0.0']);
    expect(validNextVersions(null)).toBeNull();
  });

  it('picks the highest vX.Y.Z tag numerically, ignoring other tags', () => {
    expect(latestReleaseTag('v0.9.0\nv0.122.3\nv0.123.0\nv0.10.0\nnightly-2026\n')).toBe('v0.123.0');
    expect(latestReleaseTag('')).toBeNull();
  });
});

describe('docs/index.html', () => {
  const html = [
    '    <div class="hero-eyebrow">Open Source &middot; MIT License &middot; v0.123.0</div>',
    '    <span class="badge">new in v0.118</span>',
    '  <div class="stat-item">',
    '    <span class="stat-num">8654</span>',
    '    <span class="stat-label">tests passing</span>',
    '  </div>',
    '  <div class="stat-item">',
    '    <span class="stat-num">87</span>',
    '    <span class="stat-label">built-in tools</span>',
    '  </div>',
    '  <li>87 Built-in Tools</li>',
  ].join('\n');

  it('updates the stat strip, the ticker and ONLY the current hero version', () => {
    const out = bumpLandingPage(html, { oldVersion: '0.123.0', newVersion: '0.124.0', tests: 8850, tools: 88 });
    expect(out).toContain('MIT License &middot; v0.124.0');
    expect(out).toContain('new in v0.118'); // older badges untouched
    expect(out).toMatch(/stat-num">8850<\/span>\s*<span class="stat-label">tests passing/);
    expect(out).toMatch(/stat-num">88<\/span>\s*<span class="stat-label">built-in tools/);
    expect(out).toContain('88 Built-in Tools');
  });

  it('leaves the test count alone when tests were skipped', () => {
    const out = bumpLandingPage(html, { oldVersion: '0.123.0', newVersion: '0.124.0', tools: 87 });
    expect(out).toContain('stat-num">8654</span>');
  });
});

describe('prose docs', () => {
  it('agent-mode, troubleshooting and README tool counts', () => {
    expect(bumpAgentModeDoc('SideCar has 80 built-in tools the agent can use.', { tools: 87 })).toContain(
      'SideCar has 87 built-in tools',
    );
    expect(bumpTroubleshootingDoc('— 80 tool definitions add ~20K chars.', { tools: 87 })).toContain(
      '~87 tool definitions add',
    );
    expect(bumpReadme('| **80 built-in tools** | File ops |', { tools: 87 })).toContain('**87 built-in tools**');
  });

  it('README "80+" prose is not a count and is left alone', () => {
    expect(bumpReadme('| **80+ built-in tools** |', { tools: 87 })).toBe('| **80+ built-in tools** |');
  });
});

describe('SECURITY.md', () => {
  it('rewrites the supported-version rows and keeps the table padding', () => {
    const md = [
      '| Version           | Supported |',
      '| 0.123.x (current) | ✅        |',
      '| < 0.123           | ❌        |',
    ].join('\n');
    const out = bumpSecurityTable(md, { newVersion: '0.124.0' });
    expect(out).toContain('| 0.124.x (current) | ✅        |');
    expect(out).toContain('| < 0.124           | ❌        |');
  });
});

describe('CHANGELOG.md', () => {
  const ctx = {
    oldVersion: '0.123.0',
    newVersion: '0.124.0',
    today: '2026-09-14',
    summary: '',
    tests: 8850,
    testFiles: 495,
    tools: 87,
    skills: 11,
  };

  it('rolls an [Unreleased] body under the new version and leaves Unreleased empty', () => {
    const md =
      '# Changelog\n\n## [Unreleased]\n\nIntro.\n\n### Fixed\n\n- a thing\n\n## [0.123.0] - 2026-08-06\n\nold\n';
    const out = bumpChangelog(md, ctx);
    expect(out).toContain('## [Unreleased]\n\n## [0.124.0] - 2026-09-14\n\nIntro.\n\n### Fixed\n\n- a thing\n');
    expect(out).toContain('### Stats\n- 8850 total tests (495 test files)\n- 87 built-in tools, 11 skills\n');
    expect(out.indexOf('### Stats')).toBeLessThan(out.indexOf('## [0.123.0]'));
    expect(out).toContain('## [0.123.0] - 2026-08-06\n\nold\n'); // untouched
  });

  it('with an empty [Unreleased], creates the section with just the summary and stats', () => {
    const md = '# Changelog\n\n## [Unreleased]\n\n## [0.123.0] - 2026-08-06\n\nold\n';
    const out = bumpChangelog(md, { ...ctx, summary: 'one line' });
    expect(out).toContain('## [0.124.0] - 2026-09-14\n\n### Added\n- one line\n\n### Stats\n');
    expect(out).toContain('## [Unreleased]\n\n## [0.124.0]');
  });

  it('without an [Unreleased] section, inserts before the previous version', () => {
    const md = '# Changelog\n\n## [0.123.0] - 2026-08-06\n\nold\n';
    const out = bumpChangelog(md, ctx);
    expect(out.indexOf('## [0.124.0]')).toBeLessThan(out.indexOf('## [0.123.0]'));
    expect(out).toContain('### Stats\n- 8850 total tests');
  });
});
