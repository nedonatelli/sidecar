/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLint } from './lintFix.js';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/project' } }],
    fs: {
      readFile: vi.fn(),
      stat: vi.fn(),
    },
  },
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: (fn: any) => {
    return async (cmd: string, opts?: any): Promise<{ stdout: string; stderr: string }> => {
      return new Promise((resolve: any, reject: any) => {
        fn(cmd, opts, (err: any, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });
    };
  },
}));

import { exec } from 'child_process';

const mockWorkspace = vscode.workspace as any;
const mockExec = exec as any;

describe('lintFix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runLint', () => {
    it('executes lint command successfully', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        cb(null, 'Linting complete', '');
      });

      const result = await runLint('eslint src/');

      expect(result).toEqual({
        success: true,
        output: 'Linting complete',
      });
    });

    it('returns error output on lint failure', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      const error = new Error('Lint errors found');
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        cb(error, '', 'error output');
      });

      const result = await runLint('eslint src/');

      expect(result.success).toBe(false);
    });

    it('handles command timeout', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        const error: any = new Error('Command timeout');
        error.code = 'ETIMEDOUT';
        cb(error, '', '');
      });

      const result = await runLint('eslint src/');

      expect(result.success).toBe(false);
    });

    it('executes with timeout option', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        expect(opts.timeout).toBe(60000);
        cb(null, 'Done', '');
      });

      await runLint('eslint src/');

      expect(mockExec).toHaveBeenCalled();
    });

    it('passes working directory to exec', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        expect(opts.cwd).toBe('/test/project');
        cb(null, 'Done', '');
      });

      await runLint('eslint src/');

      expect(mockExec).toHaveBeenCalled();
    });

    it('includes stderr in output on failure', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        const error: any = new Error('Failed');
        error.stderr = 'error details';
        cb(error, '', 'error details');
      });

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
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        cb(null, 'Linted 42 files, 0 errors', '');
      });

      const result = await runLint('eslint src/');

      expect(result.output).toContain('42 files');
    });

    it('executes custom lint commands', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        expect(cmd).toContain('npm run lint');
        cb(null, 'Success', '');
      });

      const result = await runLint('npm run lint');

      expect(result.success).toBe(true);
    });

    it('handles maxBuffer for large output', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        expect(opts.maxBuffer).toBe(2 * 1024 * 1024);
        cb(null, 'Done', '');
      });

      await runLint('eslint src/');

      expect(mockExec).toHaveBeenCalled();
    });

    it('trims output', async () => {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
      mockExec.mockImplementation((cmd: string, opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
        cb(null, '  \n\nOutput with padding\n\n  ', '');
      });

      const result = await runLint('eslint src/');

      expect(result.output).toBe('Output with padding');
    });
  });
});
