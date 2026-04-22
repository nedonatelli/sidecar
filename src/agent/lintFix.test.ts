/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLint, detectLintCommand, parseArgv } from './lintFix.js';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/project' } }],
    fs: {
      readFile: vi.fn(),
      stat: vi.fn(),
    },
  },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const joined = [base.fsPath, ...parts].join('/');
      return { fsPath: joined, path: joined };
    },
  },
}));

// Shared execFile vi.fn — hoisted so child_process + util mocks both see it.
const { sharedExecFile } = vi.hoisted(() => ({ sharedExecFile: vi.fn() }));

vi.mock('child_process', () => ({ execFile: sharedExecFile }));

// execFile signature: (bin, args, opts, cb) — 4 args.
// createPromisifyShim was built for exec's 3-arg form, so we inline a shim here.
vi.mock('util', () => {
  return {
    promisify: (_fn: unknown) => {
      return (bin: string, args: string[], opts?: unknown) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          let settled = false;
          const cb = (err: Error | null, stdout: string, stderr: string) => {
            settled = true;
            if (err) reject(err);
            else resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
          };
          sharedExecFile(bin, args, opts, cb);
          if (!settled) resolve({ stdout: '', stderr: '' });
        });
    },
  };
});

import { execFile } from 'child_process';

const mockWorkspace = vscode.workspace as any;
const mockExecFile = execFile as any;

describe('lintFix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runLint', () => {
    it('executes lint command successfully', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          cb(null, 'Linting complete', '');
        },
      );

      const result = await runLint('eslint src/');

      expect(result).toEqual({
        success: true,
        output: 'Linting complete',
      });
    });

    it('returns error output on lint failure', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      const error = new Error('Lint errors found');
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          cb(error, '', 'error output');
        },
      );

      const result = await runLint('eslint src/');

      expect(result.success).toBe(false);
    });

    it('handles command timeout', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          const error: any = new Error('Command timeout');
          error.code = 'ETIMEDOUT';
          cb(error, '', '');
        },
      );

      const result = await runLint('eslint src/');

      expect(result.success).toBe(false);
    });

    it('executes with timeout option', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          expect(opts.timeout).toBe(60000);
          cb(null, 'Done', '');
        },
      );

      await runLint('eslint src/');

      expect(mockExecFile).toHaveBeenCalled();
    });

    it('passes working directory to exec', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          expect(opts.cwd).toBe('/test/project');
          cb(null, 'Done', '');
        },
      );

      await runLint('eslint src/');

      expect(mockExecFile).toHaveBeenCalled();
    });

    it('includes stderr in output on failure', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          const error: any = new Error('Failed');
          error.stderr = 'error details';
          cb(error, '', 'error details');
        },
      );

      const result = await runLint('eslint src/');

      expect(result.output).toContain('error details');
    });

    it('handles no workspace gracefully', async () => {
      mockWorkspace.workspaceFolders = [];

      const result = await runLint('eslint src/');

      expect(result.success).toBe(false);
      expect(result.output).toContain('workspace');
    });

    it('formats success message', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          cb(null, 'Linted 42 files, 0 errors', '');
        },
      );

      const result = await runLint('eslint src/');

      expect(result.output).toContain('42 files');
    });

    it('executes custom lint commands via execFile (no shell)', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      // execFile receives (bin, args, opts, cb) — not a raw shell string.
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          expect(bin).toBe('npm');
          expect(args).toEqual(['run', 'lint']);
          cb(null, 'Success', '');
        },
      );

      const result = await runLint('npm run lint');

      expect(result.success).toBe(true);
    });

    it('handles maxBuffer for large output', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          expect(opts.maxBuffer).toBe(2 * 1024 * 1024);
          cb(null, 'Done', '');
        },
      );

      await runLint('eslint src/');

      expect(mockExecFile).toHaveBeenCalled();
    });

    it('trims output', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExecFile.mockImplementation(
        (bin: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          cb(null, '  \n\nOutput with padding\n\n  ', '');
        },
      );

      const result = await runLint('eslint src/');

      expect(result.output).toBe('Output with padding');
    });
  });

  // -------------------------------------------------------------------------
  // detectLintCommand (v0.65 chunk 6c gap-fill)
  // -------------------------------------------------------------------------
  describe('detectLintCommand', () => {
    beforeEach(() => {
      mockWorkspace.fs.readFile.mockReset();
      mockWorkspace.fs.stat.mockReset();
    });

    it('returns null when no workspace folder is open', async () => {
      mockWorkspace.workspaceFolders = [];
      const cmd = await detectLintCommand();
      expect(cmd).toBeNull();
    });

    it('returns "npm run lint" when package.json declares a lint script', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockResolvedValue(Buffer.from(JSON.stringify({ scripts: { lint: 'eslint .' } })));
      const cmd = await detectLintCommand();
      expect(cmd).toBe('npm run lint');
    });

    it('returns "npm run lint:fix" when only lint:fix is present (no plain lint)', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockResolvedValue(
        Buffer.from(JSON.stringify({ scripts: { 'lint:fix': 'eslint --fix .' } })),
      );
      const cmd = await detectLintCommand();
      expect(cmd).toBe('npm run lint:fix');
    });

    it('prefers plain "lint" over "lint:fix" when both are declared', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockResolvedValue(
        Buffer.from(JSON.stringify({ scripts: { lint: 'eslint .', 'lint:fix': 'eslint --fix .' } })),
      );
      const cmd = await detectLintCommand();
      expect(cmd).toBe('npm run lint');
    });

    it('falls back to .eslintrc.json when package.json has no lint script', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockResolvedValue(Buffer.from(JSON.stringify({ scripts: { build: 'tsc' } })));
      mockWorkspace.fs.stat.mockImplementation(async (uri: { fsPath?: string; path?: string }) => {
        const p = (uri.fsPath || uri.path || '').toString();
        if (p.endsWith('.eslintrc.json')) return { type: 1, size: 10 };
        throw new Error('not found');
      });
      const cmd = await detectLintCommand();
      expect(cmd).toBe('npx eslint --fix .');
    });

    it('detects ruff from pyproject.toml when no JS config exists', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockRejectedValue(new Error('no package.json'));
      mockWorkspace.fs.stat.mockImplementation(async (uri: { fsPath?: string; path?: string }) => {
        const p = (uri.fsPath || uri.path || '').toString();
        if (p.endsWith('pyproject.toml')) return { type: 1, size: 10 };
        throw new Error('not found');
      });
      const cmd = await detectLintCommand();
      expect(cmd).toBe('ruff check --fix .');
    });

    it('detects golangci-lint from .golangci.yml', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockRejectedValue(new Error('no package.json'));
      mockWorkspace.fs.stat.mockImplementation(async (uri: { fsPath?: string; path?: string }) => {
        const p = (uri.fsPath || uri.path || '').toString();
        if (p.endsWith('.golangci.yml')) return { type: 1, size: 10 };
        throw new Error('not found');
      });
      const cmd = await detectLintCommand();
      expect(cmd).toBe('golangci-lint run --fix');
    });

    it('returns null when no package.json lint script AND no known config files', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockRejectedValue(new Error('no package.json'));
      mockWorkspace.fs.stat.mockRejectedValue(new Error('no config'));
      const cmd = await detectLintCommand();
      expect(cmd).toBeNull();
    });

    it('tolerates malformed package.json (JSON.parse throws) and falls back to config probes', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockResolvedValue(Buffer.from('not valid json {{{'));
      mockWorkspace.fs.stat.mockImplementation(async (uri: { fsPath?: string; path?: string }) => {
        const p = (uri.fsPath || uri.path || '').toString();
        if (p.endsWith('.eslintrc.json')) return { type: 1, size: 10 };
        throw new Error('not found');
      });
      const cmd = await detectLintCommand();
      expect(cmd).toBe('npx eslint --fix .');
    });
  });

  describe('runLint — detection fallback', () => {
    it('returns a helpful message when no command is passed and detection fails', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockRejectedValue(new Error('no package.json'));
      mockWorkspace.fs.stat.mockRejectedValue(new Error('no config'));
      const result = await runLint();
      expect(result.success).toBe(false);
      expect(result.output).toContain('No lint command detected');
    });

    it('uses detectLintCommand when caller passes no command and detection succeeds', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.fs.readFile.mockResolvedValue(Buffer.from(JSON.stringify({ scripts: { lint: 'eslint' } })));
      mockExecFile.mockImplementation(
        (bin: string, _args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
          expect(bin).toBe('npm');
          cb(null, 'ok', '');
        },
      );
      const result = await runLint();
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// parseArgv
// ---------------------------------------------------------------------------
describe('parseArgv', () => {
  it('splits a simple command', () => {
    expect(parseArgv('npm run lint')).toEqual(['npm', ['run', 'lint']]);
  });

  it('handles quoted arguments with spaces', () => {
    expect(parseArgv('npx eslint --fix "src/my file.ts"')).toEqual(['npx', ['eslint', '--fix', 'src/my file.ts']]);
  });

  it('handles single-quoted arguments', () => {
    expect(parseArgv("npx eslint --fix 'src/my file.ts'")).toEqual(['npx', ['eslint', '--fix', 'src/my file.ts']]);
  });

  it('handles a binary with no arguments', () => {
    expect(parseArgv('flake8')).toEqual(['flake8', []]);
  });

  it('strips extra whitespace between tokens', () => {
    expect(parseArgv('  npm   run   lint  ')).toEqual(['npm', ['run', 'lint']]);
  });

  it('handles escaped spaces', () => {
    expect(parseArgv('my\\ tool --flag')).toEqual(['my tool', ['--flag']]);
  });

  it('returns empty bin for empty string', () => {
    expect(parseArgv('')).toEqual(['', []]);
  });
});
