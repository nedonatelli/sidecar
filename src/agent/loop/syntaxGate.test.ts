import { describe, it, expect, vi } from 'vitest';
import {
  parseCheckCommand,
  isCheckerUnavailable,
  hasCheckableFiles,
  runSyntaxGate,
  buildSyntaxReprompt,
} from './syntaxGate.js';

describe('parseCheckCommand', () => {
  it('maps python and js families to a per-file checker', () => {
    expect(parseCheckCommand('src/calc.py')).toContain('py_compile');
    expect(parseCheckCommand('a.js')).toContain('node --check');
    expect(parseCheckCommand('a.mjs')).toContain('node --check');
  });

  it('returns null for languages without a cheap per-file check (TS covered elsewhere)', () => {
    expect(parseCheckCommand('src/loop.ts')).toBeNull();
    expect(parseCheckCommand('README.md')).toBeNull();
  });

  it('quotes the path', () => {
    expect(parseCheckCommand('src/my file.py')).toContain("'src/my file.py'");
  });
});

describe('isCheckerUnavailable', () => {
  it('treats command-not-found / missing interpreter as unavailable (not a syntax error)', () => {
    expect(isCheckerUnavailable(127, 'python3: command not found')).toBe(true);
    expect(isCheckerUnavailable(1, 'node: command not found')).toBe(true);
    expect(isCheckerUnavailable(1, "can't open file 'x.py': No such file or directory")).toBe(true);
  });

  it('treats a real syntax error as available (will be reported)', () => {
    expect(isCheckerUnavailable(1, 'SyntaxError: invalid syntax')).toBe(false);
  });
});

describe('runSyntaxGate', () => {
  it('reports files that fail to parse, skips clean and non-checkable ones', async () => {
    const runCmd = vi.fn(async (cmd: string) => {
      if (cmd.includes('broken.py')) return { exitCode: 1, output: 'SyntaxError: invalid syntax' };
      return { exitCode: 0, output: '' };
    });
    const failures = await runSyntaxGate(['ok.py', 'broken.py', 'notes.md'], runCmd);
    expect(failures.map((f) => f.file)).toEqual(['broken.py']);
    // notes.md has no checker → no command run for it
    expect(runCmd).toHaveBeenCalledTimes(2);
  });

  it('does not report a failure when the checker is unavailable', async () => {
    const runCmd = vi.fn(async () => ({ exitCode: 127, output: 'python3: command not found' }));
    expect(await runSyntaxGate(['x.py'], runCmd)).toEqual([]);
  });

  it('returns empty when nothing is checkable (no shell needed)', async () => {
    const runCmd = vi.fn();
    expect(await runSyntaxGate(['a.ts', 'b.md'], runCmd)).toEqual([]);
    expect(runCmd).not.toHaveBeenCalled();
  });
});

describe('hasCheckableFiles', () => {
  it('is true only when a parse-checkable file is present', () => {
    expect(hasCheckableFiles(['a.ts', 'b.md'])).toBe(false);
    expect(hasCheckableFiles(['a.ts', 'c.py'])).toBe(true);
  });
});

describe('buildSyntaxReprompt', () => {
  it('names each broken file and includes its error', () => {
    const r = buildSyntaxReprompt([{ file: 'gui.py', output: 'SyntaxError: invalid syntax' }]);
    expect(r).toContain('gui.py');
    expect(r).toContain('SyntaxError');
    expect(r).toContain('does not parse');
  });
});
