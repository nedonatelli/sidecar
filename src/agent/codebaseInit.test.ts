/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateInit, buildInitContext } from './codebaseInit.js';
import * as vscode from 'vscode';

vi.mock('vscode');
vi.mock('../ollama/client.js');

const mockClient = {
  updateSystemPrompt: vi.fn(),
  complete: vi.fn(),
} as any;

const mockWorkspace = vscode.workspace as any;
const mockUri = vscode.Uri as any;

function makeWorkspaceIndex(files: Array<{ relativePath: string; sizeBytes: number; relevanceScore: number }>) {
  return {
    getFileCount: () => files.length,
    getFiles: function* () {
      yield* files;
    },
    getFileTree: () =>
      files
        .map((f) => f.relativePath)
        .sort()
        .join('\n'),
  } as any;
}

describe('codebaseInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
    mockUri.joinPath = vi.fn((_base: any, ...parts: string[]) => ({
      fsPath: '/test/project/' + parts.join('/'),
    }));
    mockWorkspace.findFiles = vi.fn().mockResolvedValue([]);
    mockWorkspace.fs = {
      readFile: vi.fn().mockRejectedValue(new Error('not found')),
      stat: vi.fn().mockRejectedValue(new Error('not found')),
    };
  });

  describe('generateInit', () => {
    it('calls LLM with project context and returns SIDECAR.md content', async () => {
      const sidecarMd = '# Project: test-project\n\nA test project.';
      mockClient.complete.mockResolvedValue(sidecarMd);

      const result = await generateInit(mockClient, null);

      expect(result).toBe(sidecarMd);
      expect(mockClient.updateSystemPrompt).toHaveBeenCalledWith(expect.stringContaining('SIDECAR.md'));
      expect(mockClient.complete).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
        4096,
      );
    });

    it('returns null when no workspace is open', async () => {
      mockWorkspace.workspaceFolders = undefined;

      const result = await generateInit(mockClient, null);

      expect(result).toBeNull();
      expect(mockClient.complete).not.toHaveBeenCalled();
    });

    it('sets the system prompt to the init prompt', async () => {
      mockClient.complete.mockResolvedValue('# Project');

      await generateInit(mockClient, null);

      expect(mockClient.updateSystemPrompt).toHaveBeenCalledWith(
        expect.stringContaining('senior software engineer onboarding'),
      );
    });

    it('passes workspace index context to the LLM', async () => {
      mockClient.complete.mockResolvedValue('# Project');
      const index = makeWorkspaceIndex([
        { relativePath: 'src/index.ts', sizeBytes: 500, relevanceScore: 1 },
        { relativePath: 'package.json', sizeBytes: 200, relevanceScore: 0.5 },
      ]);

      await generateInit(mockClient, index);

      const callArgs = mockClient.complete.mock.calls[0][0][0].content;
      expect(callArgs).toContain('File Tree');
      expect(callArgs).toContain('File Statistics');
      expect(callArgs).toContain('Total files: 2');
    });
  });

  describe('buildInitContext', () => {
    it('returns null when no workspace is open', async () => {
      mockWorkspace.workspaceFolders = undefined;

      const result = await buildInitContext(null);

      expect(result).toBeNull();
    });

    it('includes project name from workspace folder', async () => {
      const result = await buildInitContext(null);

      expect(result).toContain('Analyzing Project: project');
    });

    it('includes file statistics from workspace index', async () => {
      const index = makeWorkspaceIndex([
        { relativePath: 'src/app.ts', sizeBytes: 1024, relevanceScore: 1 },
        { relativePath: 'src/utils.ts', sizeBytes: 512, relevanceScore: 0.8 },
        { relativePath: 'README.md', sizeBytes: 256, relevanceScore: 0.3 },
      ]);

      const result = await buildInitContext(index);

      expect(result).toContain('Total files: 3');
      expect(result).toContain('.ts: 2 files');
    });

    it('includes file tree from workspace index', async () => {
      const index = makeWorkspaceIndex([{ relativePath: 'src/index.ts', sizeBytes: 100, relevanceScore: 1 }]);

      const result = await buildInitContext(index);

      expect(result).toContain('File Tree');
      expect(result).toContain('src/index.ts');
    });

    it('reads config files when they exist', async () => {
      const pkgJson = JSON.stringify({ name: 'my-project', version: '1.0.0' });
      mockWorkspace.fs.readFile = vi.fn().mockImplementation((uri: any) => {
        if (uri.fsPath.endsWith('package.json')) {
          return Promise.resolve(Buffer.from(pkgJson));
        }
        return Promise.reject(new Error('not found'));
      });

      const result = await buildInitContext(null);

      expect(result).toContain('Analyzing Project: my-project');
      expect(result).toContain('package.json');
    });

    it('detects project name from pyproject.toml', async () => {
      const pyproject = 'name = "my-python-app"\nversion = "0.1.0"';
      mockWorkspace.fs.readFile = vi.fn().mockImplementation((uri: any) => {
        if (uri.fsPath.endsWith('pyproject.toml')) {
          return Promise.resolve(Buffer.from(pyproject));
        }
        return Promise.reject(new Error('not found'));
      });

      const result = await buildInitContext(null);

      expect(result).toContain('Analyzing Project: my-python-app');
    });

    it('handles workspace index with no files gracefully', async () => {
      const index = makeWorkspaceIndex([]);

      const result = await buildInitContext(index);

      expect(result).not.toBeNull();
      expect(result).not.toContain('File Statistics');
    });
  });
});
