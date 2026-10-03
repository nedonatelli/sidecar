import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fsNode from 'fs';
import * as osNode from 'os';
import * as pathNode from 'path';
import { relaxSnippetPattern, looksLikePathQuery, grep } from './search.js';

// Every pattern below is a real grep call taken from the scaffoldab SWE-bench
// matrix, from runs that never found the file they were trying to fix.

describe('relaxSnippetPattern — a pasted snippet has a searchable term inside it', () => {
  it.each([
    ['class ArticleForm(forms.ModelForm):', 'ArticleForm'],
    ['class Command(BaseCommand):', 'BaseCommand'],
    ['class Field(models.Field):', 'models'],
    ['logging.Logger.store.message("logged", "testrunner",', 'testrunner'],
    ['def is_within_bounds(self, value):', 'is_within_bounds'],
  ])('reduces %j to %j', (pattern, expected) => {
    expect(relaxSnippetPattern(pattern)).toBe(expected);
  });

  it('returns null for a bare term, which has nothing to relax to', () => {
    // The run searched `tzkt_import` six times. There is no shorter form to
    // try, so the tool must say the term is absent rather than invent one.
    expect(relaxSnippetPattern('tzkt_import')).toBeNull();
    expect(relaxSnippetPattern('label_for_field')).toBeNull();
  });

  it('returns null when a snippet is only keywords and punctuation', () => {
    expect(relaxSnippetPattern('if not self:')).toBeNull();
    expect(relaxSnippetPattern('return None')).toBeNull();
  });

  it('skips language keywords when picking the distinctive token', () => {
    // 'class' is longer than 'Meta' but carries no information.
    expect(relaxSnippetPattern('class Meta:')).toBe('Meta');
  });

  it('ignores one- and two-character tokens', () => {
    expect(relaxSnippetPattern('a.b(c)')).toBeNull();
  });
});

describe('looksLikePathQuery — grep searches contents, not names', () => {
  it.each(['admin_utils/**', 'model_fields/', 'django/utils/html.py', 'tests/*.py'])(
    'recognises %j as a path or glob',
    (p) => {
      expect(looksLikePathQuery(p)).toBe(true);
    },
  );

  it.each(['label_for_field', 'BaseCommand', 'strip_tags'])('leaves the bare term %j alone', (p) => {
    expect(looksLikePathQuery(p)).toBe(false);
  });

  it('does not treat a code snippet as a path just because it contains a dot', () => {
    // Spaces mean it is content being searched for, however it is punctuated.
    expect(looksLikePathQuery('logging.Logger.store.message("logged",')).toBe(false);
  });
});

describe('grep — what a zero-hit search reports', () => {
  // Needs a real filesystem: grep runs as a child process against `cwd`.
  const root = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'zerohit-'));
  beforeAll(() => {
    fsNode.writeFileSync(pathNode.join(root, 'app.py'), 'class ArticleForm(FormBase):\n    pass\n');
  });
  afterAll(() => fsNode.rmSync(root, { recursive: true, force: true }));
  const ctx = (zeroHitPatterns?: Map<string, number>) => ({ cwd: root, zeroHitPatterns }) as never;

  it('still returns matches normally', async () => {
    const out = await grep({ pattern: 'ArticleForm' }, ctx());
    expect(out).toContain('app.py');
    expect(out).not.toContain('No matches found');
  });

  it('says a term is simply absent, and where it looked', async () => {
    const out = await grep({ pattern: 'tzkt_import' }, ctx());
    expect(out).toContain('No matches found');
    expect(out).toMatch(/does not appear anywhere/i);
  });

  it('SEARCHES THE RELAXED TERM and reports the hits it found', async () => {
    // The whole point: `class ArticleForm(forms.ModelForm):` cannot match one
    // line, but `ArticleForm` can — and the run that hit this took several
    // turns to discover that for itself.
    const out = await grep({ pattern: 'class ArticleForm(forms.ModelForm):' }, ctx());
    expect(out).toMatch(/ArticleForm.*DOES match/s);
    expect(out).toContain('app.py');
  });

  it('says so when neither the snippet nor its key term exists', async () => {
    const out = await grep({ pattern: 'class Nonexistent(Thing):' }, ctx());
    expect(out).toMatch(/not in the repository either/i);
    expect(out).toMatch(/issue report/i);
  });

  it('redirects a path-shaped pattern to search_files', async () => {
    const out = await grep({ pattern: 'admin_utils/**' }, ctx());
    expect(out).toMatch(/search_files/);
    expect(out).toMatch(/CONTENTS, not names/);
  });

  it('suggests a glob on the file NAME, not the slashes squeezed out of a full path', async () => {
    // Stripping every `/` turned `django/contrib/admin/checks.py` into
    // `**/*djangocontribadminchecks*`, which matches nothing — the redirect
    // failed on exactly the patterns it exists for.
    const full = await grep({ pattern: 'django/contrib/admin/checks.py' }, ctx());
    expect(full).toContain('search_files(pattern="**/*checks*")');
    const dir = await grep({ pattern: 'admin_utils/**' }, ctx());
    expect(dir).toContain('search_files(pattern="**/*admin_utils*")');
    const ext = await grep({ pattern: '*.py' }, ctx());
    expect(ext).toContain('search_files(pattern="**/*.py")');
  });

  it('refuses to answer the same dead question twice', async () => {
    // 44.6% of zero-hit greps repeated a pattern the run had already answered.
    const seen = new Map<string, number>();
    await grep({ pattern: 'tzkt_import' }, ctx(seen));
    const second = await grep({ pattern: 'tzkt_import' }, ctx(seen));
    expect(second).toMatch(/already searched for this exact pattern once/i);
    const third = await grep({ pattern: 'tzkt_import' }, ctx(seen));
    expect(third).toMatch(/already searched for this exact pattern 2 times/i);
  });

  it('does not call a WIDER search a repeat of a narrower one', async () => {
    // Absent from one directory is not absent from the repository: widening the
    // search is the right next move, and must not be told it is already answered.
    fsNode.mkdirSync(pathNode.join(root, 'sub'), { recursive: true });
    fsNode.writeFileSync(pathNode.join(root, 'sub', 'x.py'), 'pass\n');
    const seen = new Map<string, number>();
    await grep({ pattern: 'only_elsewhere', path: 'sub' }, ctx(seen));
    const wider = await grep({ pattern: 'only_elsewhere' }, ctx(seen));
    expect(wider).not.toMatch(/already searched/i);
    const again = await grep({ pattern: 'only_elsewhere' }, ctx(seen));
    expect(again).toMatch(/already searched for this exact pattern once/i);
  });

  it('EXPERIMENT SWITCH: SIDECAR_GREP_ZERO_HIT=off restores the bare pre-#81 reply', async () => {
    const prev = process.env.SIDECAR_GREP_ZERO_HIT;
    process.env.SIDECAR_GREP_ZERO_HIT = 'off';
    try {
      const seen = new Map<string, number>();
      expect(await grep({ pattern: 'tzkt_import' }, ctx(seen))).toBe('No matches found.');
      expect(await grep({ pattern: 'class ArticleForm(forms.ModelForm):' }, ctx(seen))).toBe('No matches found.');
      expect(await grep({ pattern: 'admin_utils/**' }, ctx(seen))).toBe('No matches found.');
      expect(await grep({ pattern: 'ArticleForm' }, ctx(seen))).toMatch(/app\.py/);
    } finally {
      if (prev === undefined) delete process.env.SIDECAR_GREP_ZERO_HIT;
      else process.env.SIDECAR_GREP_ZERO_HIT = prev;
    }
  });

  it('works without the tracker, since tools are called outside the loop too', async () => {
    const a = await grep({ pattern: 'tzkt_import' }, ctx(undefined));
    const b = await grep({ pattern: 'tzkt_import' }, ctx(undefined));
    expect(b).toBe(a);
    expect(b).not.toMatch(/already searched/i);
  });
});
