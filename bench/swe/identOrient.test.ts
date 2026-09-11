import { describe, it, expect } from 'vitest';
import {
  extractIdentifiers,
  rankFilesByHits,
  formatOrientation,
  orientationRecall,
  MAX_FILES,
  MAX_IDENTIFIERS,
} from './identOrient.js';

const issue = `
UsernameValidator allows trailing newline in usernames

Description: \`ASCIIUsernameValidator\` and \`UnicodeUsernameValidator\` use the regex
\`r'^[\\w.@+-]+$'\`. The intent is that only certain characters are allowed, but
\`$\` will also match a trailing newline. Should use \`\\A\` and \`\\Z\` instead.
See django.contrib.auth.validators for the definitions; test_validators covers it.
The error message says "Enter a valid username" and the value is rejected.
`;

describe('extractIdentifiers', () => {
  it('prefers what the reporter marked as code, then dotted paths and CamelCase', () => {
    const ids = extractIdentifiers(issue);
    expect(ids[0]).toBe('UnicodeUsernameValidator'); // backticked, longest
    expect(ids[1]).toBe('ASCIIUsernameValidator');
    expect(ids).toContain('django.contrib.auth.validators');
    expect(ids).toContain('UsernameValidator');
    expect(ids).toContain('test_validators');
  });

  it('drops generic prose words that would match every file', () => {
    // "error", "value", "Description" are the kind of token that turns a
    // ranked list into the whole repository.
    const ids = extractIdentifiers(issue);
    expect(ids).not.toContain('error');
    expect(ids).not.toContain('value');
    expect(ids).not.toContain('Description');
    expect(ids).not.toContain('Enter');
  });

  it('caps the count so the block stays an orientation, not an index', () => {
    const many = Array.from({ length: 40 }, (_, i) => `\`some_identifier_${i}\``).join(' ');
    expect(extractIdentifiers(many)).toHaveLength(MAX_IDENTIFIERS);
    expect(extractIdentifiers(many, 3)).toHaveLength(3);
  });

  it('is deterministic for the same statement', () => {
    expect(extractIdentifiers(issue)).toEqual(extractIdentifiers(issue));
  });

  it('returns nothing for prose with no code-shaped tokens', () => {
    expect(extractIdentifiers('The page is slow and looks wrong on my phone.')).toEqual([]);
  });
});

describe('rankFilesByHits', () => {
  const hits = new Map<string, string[]>([
    ['UnicodeUsernameValidator', ['django/contrib/auth/validators.py', 'tests/auth_tests/test_validators.py']],
    ['ASCIIUsernameValidator', ['django/contrib/auth/validators.py', 'tests/auth_tests/test_validators.py']],
    ['UsernameValidator', ['django/contrib/auth/validators.py', 'django/contrib/auth/models.py']],
  ]);

  it('ranks by DISTINCT identifiers matched, source files before tests at a tie', () => {
    const r = rankFilesByHits(hits);
    expect(r.map((x) => x.path)).toEqual([
      'django/contrib/auth/validators.py', // 3 distinct
      'tests/auth_tests/test_validators.py', // 2 distinct, but a test
      'django/contrib/auth/models.py', // 1
    ]);
    expect(r[0].matched).toEqual(['ASCIIUsernameValidator', 'UnicodeUsernameValidator', 'UsernameValidator']);
  });

  it('normalizes backslash paths so Windows git output ranks with the gold patch', () => {
    const r = rankFilesByHits(new Map([['x', ['a\\b.py']]]));
    expect(r[0].path).toBe('a/b.py');
  });

  it('caps the list', () => {
    const wide = new Map([['x', Array.from({ length: 50 }, (_, i) => `f${i}.py`)]]);
    expect(rankFilesByHits(wide)).toHaveLength(MAX_FILES);
  });
});

describe('formatOrientation', () => {
  it('names files and matched terms and never includes code', () => {
    const block = formatOrientation(
      ['UsernameValidator'],
      [{ path: 'django/contrib/auth/validators.py', matched: ['UsernameValidator'] }],
    );
    expect(block).toContain('- django/contrib/auth/validators.py  (UsernameValidator)');
    expect(block).toMatch(/leads, not answers/);
    expect(block).not.toMatch(/class |def |import /);
  });

  it('is empty when there is nothing to say, so the prompt is untouched', () => {
    expect(formatOrientation([], [])).toBe('');
    expect(formatOrientation(['x'], [])).toBe('');
  });
});

describe('orientationRecall', () => {
  const gold = `diff --git a/django/contrib/auth/validators.py b/django/contrib/auth/validators.py
--- a/django/contrib/auth/validators.py
+++ b/django/contrib/auth/validators.py
@@ -1 +1 @@
-x
+y
`;
  it('is true when a named file is one the gold patch touches', () => {
    expect(orientationRecall([{ path: 'django/contrib/auth/validators.py', matched: [] }], gold)).toBe(true);
  });
  it('is false otherwise', () => {
    expect(orientationRecall([{ path: 'django/contrib/auth/models.py', matched: [] }], gold)).toBe(false);
    expect(orientationRecall([], gold)).toBe(false);
  });
});
