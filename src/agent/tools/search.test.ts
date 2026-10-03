import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findReferences, grep } from './search.js';
import type { ToolExecutorContext } from './shared.js';
import type { SymbolEntry, SymbolReference } from '../../config/symbolGraph.js';

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: mockExecFile }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(name: string, filePath: string): SymbolEntry {
  return {
    name,
    qualifiedName: name,
    type: 'function',
    filePath,
    startLine: 0,
    endLine: 10,
    exported: true,
  };
}

function makeRef(file: string, line: number, context = `${file} context`): SymbolReference {
  return { file, line, context };
}

function makeContext(overrides: {
  lookupSymbol?: (name: string) => SymbolEntry[];
  getDependents?: (filePath: string) => string[];
  findReferences?: (name: string) => SymbolReference[];
}): ToolExecutorContext {
  return {
    toolRuntime: {
      symbolGraph: {
        lookupSymbol: overrides.lookupSymbol ?? (() => []),
        getDependents: overrides.getDependents ?? (() => []),
        findReferences: overrides.findReferences ?? (() => []),
      } as never,
    } as never,
  } as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findReferences', () => {
  it('returns "not available" when no symbol graph is present', async () => {
    const result = await findReferences({ symbol: 'myFn' }, {} as never);
    expect(result).toContain('not available');
  });

  it('returns error when symbol name is empty', async () => {
    const ctx = makeContext({ lookupSymbol: () => [] });
    const result = await findReferences({ symbol: '' }, ctx);
    expect(result).toContain('symbol name is required');
  });

  it('returns "not found" when symbol has no definitions', async () => {
    const ctx = makeContext({ lookupSymbol: () => [] });
    const result = await findReferences({ symbol: 'unknownFn' }, ctx);
    expect(result).toContain('No symbol named "unknownFn" found');
  });

  it('lists definitions and returns formatted output', async () => {
    const ctx = makeContext({
      lookupSymbol: () => [makeEntry('myFn', 'src/foo.ts')],
      getDependents: () => [],
      findReferences: () => [makeRef('src/bar.ts', 5)],
    });
    const result = await findReferences({ symbol: 'myFn' }, ctx);
    expect(result).toContain('myFn');
    expect(result).toContain('src/foo.ts');
  });

  it('shows "... and N more" for dependents when count exceeds 20', async () => {
    const deps = Array.from({ length: 25 }, (_, i) => `src/dep${i}.ts`);
    const ctx = makeContext({
      lookupSymbol: () => [makeEntry('bigFn', 'src/core.ts')],
      getDependents: () => deps,
      findReferences: () => [],
    });
    const result = await findReferences({ symbol: 'bigFn' }, ctx);
    expect(result).toContain('and 5 more');
  });

  it('filters references by filterFile when provided', async () => {
    const refs = [makeRef('src/alpha.ts', 1), makeRef('src/beta.ts', 2), makeRef('src/gamma.ts', 3)];
    const ctx = makeContext({
      lookupSymbol: () => [makeEntry('filterFn', 'src/alpha.ts')],
      getDependents: () => [],
      findReferences: () => refs,
    });
    const result = await findReferences({ symbol: 'filterFn', file: 'alpha' }, ctx);
    expect(result).toContain('alpha.ts');
    expect(result).not.toContain('beta.ts');
    expect(result).not.toContain('gamma.ts');
  });

  it('shows "... and N more" for references when count exceeds 30', async () => {
    const refs = Array.from({ length: 35 }, (_, i) => makeRef(`src/ref${i}.ts`, i));
    const ctx = makeContext({
      lookupSymbol: () => [makeEntry('popularFn', 'src/core.ts')],
      getDependents: () => [],
      findReferences: () => refs,
    });
    const result = await findReferences({ symbol: 'popularFn' }, ctx);
    expect(result).toContain('and 5 more');
  });

  it('truncates output when result exceeds 5000 characters', async () => {
    // generate a large number of dependents + long context to blow past 5000 chars
    const longDeps = Array.from({ length: 20 }, (_, i) => `src/${'a'.repeat(60)}-dep${i}.ts`);
    const longRefs = Array.from({ length: 30 }, (_, i) =>
      makeRef(`src/${'b'.repeat(50)}-ref${i}.ts`, i, `context ${'x'.repeat(100)}`),
    );
    const ctx = makeContext({
      lookupSymbol: () => [makeEntry('hugeFn', 'src/core.ts')],
      getDependents: () => longDeps,
      findReferences: () => longRefs,
    });
    const result = await findReferences({ symbol: 'hugeFn' }, ctx);
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThanOrEqual(5010);
  });

  it('applies filterFile to definitions when specified', async () => {
    const ctx = makeContext({
      lookupSymbol: () => [makeEntry('sharedFn', 'src/a.ts'), makeEntry('sharedFn', 'src/b.ts')],
      getDependents: () => [],
      findReferences: () => [],
    });
    const result = await findReferences({ symbol: 'sharedFn', file: 'src/a.ts' }, ctx);
    expect(result).toContain('src/a.ts');
  });
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

describe('grep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted matches when grep finds results', async () => {
    mockExecFile.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null, result: { stdout: string }) => void) => {
        cb(null, { stdout: 'src/foo.ts:10:const x = 1;\nsrc/bar.ts:5:const x = 2;\n' });
      },
    );
    const result = await grep({ pattern: 'const x' });
    expect(result).toContain('src/foo.ts');
  });

  it('returns No matches found when stdout is empty', async () => {
    mockExecFile.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null, result: { stdout: string }) => void) => {
        cb(null, { stdout: '   ' });
      },
    );
    const result = await grep({ pattern: 'nonexistent' });
    // A zero-hit search now explains itself instead of returning a bare string
    // — see searchZeroHit.test.ts. The lead phrase is still the contract, so a
    // caller (or a grep of the logs) looking for "No matches found" still works.
    expect(result).toMatch(/^No matches found\./);
    expect(result).toMatch(/does not appear anywhere/i);
  });

  it('returns No matches found when grep exits with code 1', async () => {
    const err = Object.assign(new Error('no match'), { code: 1, stdout: '' });
    mockExecFile.mockImplementationOnce((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
      cb(err);
    });
    const result = await grep({ pattern: 'zzz' });
    expect(result).toMatch(/^No matches found\./);
    expect(result).toMatch(/does not appear anywhere/i);
  });

  it('returns the matches when grep exits 2 after finding some (an unreadable file elsewhere in the tree)', async () => {
    // grep writes errors to STDERR; stdout only ever holds matches. Under -r it
    // exits 2 if any one file could not be read, even after printing real hits
    // from the rest -- those hits used to be shown as an "error".
    const err = Object.assign(new Error('grep: some/file: Permission denied'), {
      code: 2,
      stdout: 'src/foo.ts:10:const foo = 1;\n',
    });
    mockExecFile.mockImplementationOnce((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
      cb(err);
    });
    const result = await grep({ pattern: 'foo' });
    expect(result).toContain('src/foo.ts');
    expect(result).not.toMatch(/Grep failed|Perl-style/);
  });

  describe('a timeout is a timeout, not a regex error and not an absence', () => {
    // All 18 "Grep failed" results in a 300-run SWE-bench matrix took
    // 15,012-15,040 ms: execFile's timeout, reported as a regex problem.
    const timedOut = (stdout = '') =>
      Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null, stdout });

    it('says it timed out, and does not blame regex syntax', async () => {
      mockExecFile.mockImplementationOnce((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error) => void) => {
        cb(timedOut());
      });
      const result = await grep({ pattern: 'FILE_UPLOAD_PERMISSION' });
      expect(result).toMatch(/timed out after 15s searching the whole repository/);
      expect(result).toMatch(/not mean the pattern is absent/);
      expect(result).toMatch(/Narrow `path`/);
      expect(result).not.toMatch(/Perl-style|Grep failed|No matches found/);
    });

    it('returns the matches it found before the timeout, marked partial', async () => {
      mockExecFile.mockImplementationOnce((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error) => void) => {
        cb(timedOut('django/conf/global_settings.py:307:FILE_UPLOAD_PERMISSIONS = None\n'));
      });
      const result = await grep({ pattern: 'FILE_UPLOAD_PERMISSION', path: 'django' });
      expect(result).toContain('global_settings.py');
      expect(result).toMatch(/Partial results — grep timed out after 15s searching django/);
    });

    it('does not record a timed-out pattern as proven absent', async () => {
      const seen = new Map<string, number>();
      mockExecFile.mockImplementationOnce((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error) => void) => {
        cb(timedOut());
      });
      await grep({ pattern: 'tzkt_import' }, { zeroHitPatterns: seen } as never);
      expect(seen.size).toBe(0);
    });

    it('does not claim a snippet identifier is absent when the RELAXED search timed out', async () => {
      // First call: the snippet itself, a clean zero-hit (exit 1). Second: the
      // relaxed identifier search, which times out and therefore proves nothing.
      mockExecFile
        .mockImplementationOnce((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error) => void) => {
          cb(Object.assign(new Error('no match'), { code: 1, stdout: '' }));
        })
        .mockImplementationOnce((_c: unknown, _a: unknown, _o: unknown, cb: (err: Error) => void) => {
          cb(timedOut());
        });
      const result = await grep({ pattern: 'class ArticleForm(forms.ModelForm):' });
      expect(result).toMatch(/"ArticleForm" TIMED OUT/);
      expect(result).toMatch(/unknown/);
      expect(result).not.toMatch(/not in the repository either/);
    });
  });

  it('returns actionable hint when grep exits with regex error and no stdout/stderr', async () => {
    const err = Object.assign(new Error('grep crashed'), { code: 2 });
    mockExecFile.mockImplementationOnce((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
      cb(err);
    });
    const result = await grep({ pattern: 'foo' });
    expect(result).toContain('Grep failed.');
    expect(result).toContain('run_command');
  });

  it('includes stderr detail in grep error message', async () => {
    const err = Object.assign(new Error('grep crashed'), { code: 2, stderr: 'grep: invalid regex' });
    mockExecFile.mockImplementationOnce((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
      cb(err);
    });
    const result = await grep({ pattern: '\\s+' });
    expect(result).toContain('grep: invalid regex');
    expect(result).toContain('run_command');
  });

  it('runs grep in context.cwd (shadow worktree) when a cwd override is set', async () => {
    const SHADOW = '/tmp/.sidecar/shadows/task-1';
    let seenCwd: string | undefined;
    mockExecFile.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, opts: { cwd?: string }, cb: (err: null, r: { stdout: string }) => void) => {
        seenCwd = opts.cwd;
        cb(null, { stdout: '' });
      },
    );
    await grep({ pattern: 'x' }, { cwd: SHADOW } as ToolExecutorContext);
    expect(seenCwd).toBe(SHADOW);
  });
});

describe('searchFiles — name-vs-content teaching (2026-08 audit)', () => {
  // granite concluded an entire task was a no-op after name-searching for
  // CONTENT (search-then-edit-multi-file), and never looked inside a directory
  // it had already listed (latch-stale-fact). A bare "No files found." taught
  // nothing; the retry + teaching message close both holes.
  beforeEach(() => vi.restoreAllMocks());

  it('retries a bare word as a name substring and labels the match', async () => {
    const { workspace, Uri } = await import('vscode');
    const calls: string[] = [];
    vi.spyOn(workspace, 'findFiles').mockImplementation(async (pattern: unknown) => {
      calls.push(String(pattern));
      if (String(pattern) === '**/*config*/**') return [Uri.file('/root/config/app.json')] as never;
      return [] as never;
    });
    const { searchFiles } = await import('./search.js');
    const out = await searchFiles({ pattern: 'config' });
    expect(calls[0]).toBe('config'); // literal attempt first
    expect(out).toContain('matched "config" as a name substring');
    expect(out).toContain('app.json');
  });

  it('teaches names-vs-contents when nothing matches at all', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([] as never);
    const { searchFiles } = await import('./search.js');
    const out = await searchFiles({ pattern: 'legacy' });
    expect(out).toContain('does not search file');
    expect(out).toContain('grep');
  });

  it('does not retry a real glob — only bare terms get the substring fallback', async () => {
    const { workspace } = await import('vscode');
    const spy = vi.spyOn(workspace, 'findFiles').mockResolvedValue([] as never);
    const { searchFiles } = await import('./search.js');
    await searchFiles({ pattern: '**/*.rs' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
