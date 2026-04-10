/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeDependencies } from './depAnalysis.js';

// Mock vscode workspace
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    fs: {
      readFile: vi.fn(),
      stat: vi.fn(),
    },
  },
  Uri: {
    joinPath: vi.fn((base, path) => ({ fsPath: `/test/${path}` })),
  },
}));

// Mock child_process exec
vi.mock('child_process', () => ({
  exec: vi.fn((cmd, opts, cb) => {
    process.nextTick(() => cb(new Error('exec disabled in tests')));
  }),
  execFile: vi.fn((cmd, args, opts, cb) => {
    process.nextTick(() => cb(new Error('execFile disabled in tests')));
  }),
}));

// Mock util promisify
vi.mock('util', () => ({
  promisify: (fn: (cmd: string, opts: Record<string, unknown>, cb: (err: Error | null) => void) => void) => {
    return async (cmd: string, opts?: Record<string, unknown>) => {
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        fn(cmd, opts || {}, (err) => {
          if (err) reject(err);
          else resolve({ stdout: '', stderr: '' });
        });
      });
    };
  },
}));

import * as vscode from 'vscode';

const mockWorkspace = vscode.workspace as any;

describe('analyzeDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockWorkspace as any).workspaceFolders = [];
  });

  it('returns error message when no workspace is open', async () => {
    (mockWorkspace as any).workspaceFolders = [];
    const result = await analyzeDependencies();
    expect(result).toContain('No workspace folder open');
  });

  it('analyzes Node.js project', async () => {
    const mockPackage = {
      name: 'test-project',
      version: '1.0.0',
    };

    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(Buffer.from(JSON.stringify(mockPackage)));

    const result = await analyzeDependencies();
    expect(result).toContain('test-project');
    expect(result).toContain('1.0.0');
  });

  it('displays markdown headers', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'my-app', version: '1.0.0' })),
    );

    const result = await analyzeDependencies();
    expect(result).toContain('# Dependency Analysis');
    expect(result).toContain('## Summary');
  });

  it('includes dependency table', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'test', version: '1.0.0' })),
    );

    const result = await analyzeDependencies();
    expect(result).toContain('|');
    expect(result).toContain('Type');
  });

  it('counts zero dependencies', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'my-app', version: '2.0.0' })),
    );

    const result = await analyzeDependencies();
    expect(result).toContain('Production | 0');
    expect(result).toContain('Development | 0');
  });

  it('handles missing package.json', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(vscode.workspace.fs.stat as any).mockRejectedValue(new Error('ENOENT'));

    const result = await analyzeDependencies();
    expect(result).toContain('No supported package manifest found');
  });

  it('handles invalid JSON', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValueOnce(Buffer.from('invalid'));
    vi.mocked(vscode.workspace.fs.stat as any).mockRejectedValue(new Error('ENOENT'));

    const result = await analyzeDependencies();
    expect(result).toContain('No supported package manifest found');
  });

  it('creates markdown output', async () => {
    (mockWorkspace as any).workspaceFolders = [{ uri: { fsPath: '/test/project' } }];

    vi.mocked(vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'test-app', version: '1.0.0' })),
    );

    const result = await analyzeDependencies();
    expect(result).toMatch(/# Dependency Analysis/);
    expect(result).toMatch(/\|.*Type.*Count/);
  });
});
