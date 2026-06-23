import { describe, it, expect, vi } from 'vitest';
import {
  parseCheckCommand,
  isCheckerUnavailable,
  hasSyntaxErrorEvidence,
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

describe('hasSyntaxErrorEvidence', () => {
  it('is true only when the output names a real parse error', () => {
    expect(hasSyntaxErrorEvidence('SyntaxError: invalid syntax')).toBe(true);
    expect(hasSyntaxErrorEvidence('IndentationError: unexpected indent')).toBe(true);
    expect(hasSyntaxErrorEvidence('TabError: inconsistent use of tabs')).toBe(true);
    expect(hasSyntaxErrorEvidence('')).toBe(false);
    expect(hasSyntaxErrorEvidence('some unrelated shell noise')).toBe(false);
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

  it('does NOT fire on a nonzero exit with no syntax-error evidence (flaky shell exit code)', async () => {
    // Regression: a valid file whose checker exits nonzero with empty output
    // (stale/garbled shell exit code) must never be reported — that false
    // positive made a weak model "fix" working code and corrupt it.
    const runCmd = vi.fn(async () => ({ exitCode: 1, output: '' }));
    expect(await runSyntaxGate(['valid.py'], runCmd)).toEqual([]);
  });

  it('FIRES on real syntax-error output even when the shell misreports exit 0', async () => {
    // Regression (mirror of the above): the shell session's sentinel parser can
    // default the exit code to 0 on a command that actually failed. Gating on
    // `exitCode === 0` would skip genuinely broken code (false negative). The
    // SyntaxError text is the source of truth, not the exit code.
    const runCmd = vi.fn(async () => ({
      exitCode: 0,
      output: "  File \"gui.py\", line 112\nSyntaxError: expected 'except' or 'finally' block",
    }));
    const failures = await runSyntaxGate(['gui.py'], runCmd);
    expect(failures.map((f) => f.file)).toEqual(['gui.py']);
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
