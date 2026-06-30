import { describe, it, expect } from 'vitest';
import { extractVersionSection, changelogMarkdownToHtml, buildWhatsNewHtml, shouldPromptWhatsNew } from './whatsNew.js';

describe('shouldPromptWhatsNew', () => {
  const base = { currentVersion: '0.114.49', lastSeen: '0.114.47', hadPriorState: true, enabled: true };

  it('prompts an existing user on a version change (lastSeen recorded)', () => {
    expect(shouldPromptWhatsNew(base)).toBe(true);
  });

  it('prompts an existing user updating in from a pre-feature build (no lastSeen, but prior state)', () => {
    // The 0.114.47 -> 0.114.49 case: feature never ran before, so lastSeen is
    // undefined, but the user has other SideCar globalState.
    expect(shouldPromptWhatsNew({ ...base, lastSeen: undefined, hadPriorState: true })).toBe(true);
  });

  it('stays silent for a truly fresh install (no lastSeen, no prior state)', () => {
    expect(shouldPromptWhatsNew({ ...base, lastSeen: undefined, hadPriorState: false })).toBe(false);
  });

  it('stays silent when the user already saw this version', () => {
    expect(shouldPromptWhatsNew({ ...base, lastSeen: '0.114.49' })).toBe(false);
  });

  it('stays silent when disabled or version is missing', () => {
    expect(shouldPromptWhatsNew({ ...base, enabled: false })).toBe(false);
    expect(shouldPromptWhatsNew({ ...base, currentVersion: '' })).toBe(false);
  });
});

const SAMPLE = `# Changelog

## [Unreleased]

## [0.114.47] - 2026-06-28

### Added

- **A feature** with \`code\` and a [link](https://example.com/x).

## [0.114.46] - 2026-06-28

### Fixed

- An older fix.
`;

describe('extractVersionSection', () => {
  it('returns the body between the version heading and the next one', () => {
    const s = extractVersionSection(SAMPLE, '0.114.47');
    expect(s).toContain('### Added');
    expect(s).toContain('**A feature**');
    expect(s).not.toContain('An older fix'); // stops at the next ## [
    expect(s).not.toContain('0.114.46');
  });

  it('handles the last version (no following heading)', () => {
    const s = extractVersionSection(SAMPLE, '0.114.46');
    expect(s).toContain('An older fix');
    expect(s).not.toContain('## [');
  });

  it('returns null for a version with no section', () => {
    expect(extractVersionSection(SAMPLE, '9.9.9')).toBeNull();
  });

  it('does not match a version that is only a prefix of another', () => {
    // "0.114.4" must not match the "0.114.47" heading.
    expect(extractVersionSection(SAMPLE, '0.114.4')).toBeNull();
  });
});

describe('changelogMarkdownToHtml', () => {
  it('renders headings, bold, code, links, and lists', () => {
    const html = changelogMarkdownToHtml('### Added\n\n- **bold** and `code` and [t](https://e.com/p)');
    expect(html).toContain('<h3>Added</h3>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://e.com/p">t</a>');
    expect(html).toContain('</ul>');
  });

  it('escapes raw HTML so changelog text cannot inject markup', () => {
    const html = changelogMarkdownToHtml('- a <script>alert(1)</script> & <b>x</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});

describe('buildWhatsNewHtml', () => {
  it('includes the version title, a CSP, and the rendered section', () => {
    const html = buildWhatsNewHtml('0.114.47', '### Added\n- **x**', 'vscode-resource:');
    expect(html).toContain("What's New in SideCar v0.114.47");
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('<strong>x</strong>');
  });

  it('falls back to a changelog link when the section is missing', () => {
    const html = buildWhatsNewHtml('9.9.9', null, 'vscode-resource:');
    expect(html).toContain('full changelog');
    expect(html).toContain('9.9.9');
  });
});
