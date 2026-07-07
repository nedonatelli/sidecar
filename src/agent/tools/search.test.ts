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
    expect(result).toBe('No matches found.');
  });

  it('returns No matches found when grep exits with code 1', async () => {
    const err = Object.assign(new Error('no match'), { code: 1, stdout: '' });
    mockExecFile.mockImplementationOnce((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
      cb(err);
    });
    const result = await grep({ pattern: 'zzz' });
    expect(result).toBe('No matches found.');
  });

  it('includes stdout detail and hint on other grep failures', async () => {
    const err = Object.assign(new Error('grep crashed'), { code: 2, stdout: 'partial output' });
    mockExecFile.mockImplementationOnce((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
      cb(err);
    });
    const result = await grep({ pattern: 'foo' });
    expect(result).toContain('partial output');
    expect(result).toContain('run_command');
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
