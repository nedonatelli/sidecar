/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSpec, saveSpec } from './specDriven.js';
import * as vscode from 'vscode';

vi.mock('vscode');
vi.mock('../ollama/client.js');
vi.mock('../config/workspace.js');
vi.mock('../config/sidecarDir.js');

import { getWorkspaceRoot } from '../config/workspace.js';

const mockClient = {
  updateSystemPrompt: vi.fn(),
  complete: vi.fn(),
} as any;

const mockWindow = vscode.window as any;
const mockWorkspace = vscode.workspace as any;
const mockUri = vscode.Uri as any;

describe('specDriven', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateSpec', () => {
    it('generates spec using LLM', async () => {
      mockClient.complete.mockResolvedValue(`# Feature: User Authentication
        
## Requirements
REQ-001: When user provides credentials, the system shall authenticate the user

## Design
Architecture overview of authentication system`);

      const result = await generateSpec(mockClient, 'User authentication feature');

      expect(result).toContain('Feature');
      expect(mockClient.complete).toHaveBeenCalled();
    });

    it('uses SPEC_SYSTEM_PROMPT', async () => {
      mockClient.complete.mockResolvedValue('# Feature: Test');

      await generateSpec(mockClient, 'feature description');

      expect(mockClient.updateSystemPrompt).toHaveBeenCalled();
      const prompt = mockClient.updateSystemPrompt.mock.calls[0][0];
      expect(prompt).toContain('specification');
    });

    it('includes prompt in LLM request', async () => {
      const prompt = 'Create a spec for user login flow';
      mockClient.complete.mockResolvedValue('# Feature: User Login');

      await generateSpec(mockClient, prompt);

      expect(mockClient.complete).toHaveBeenCalled();
      const messages = mockClient.complete.mock.calls[0][0];
      expect(messages[0].content).toContain(prompt);
    });

    it('handles LLM errors', async () => {
      mockClient.complete.mockRejectedValue(new Error('LLM service unavailable'));

      const result = await generateSpec(mockClient, 'test');

      expect(result).toBeNull();
    });

    it('requests 4096 token budget', async () => {
      mockClient.complete.mockResolvedValue('# Feature: Test');

      await generateSpec(mockClient, 'description');

      expect(mockClient.complete).toHaveBeenCalled();
      const tokenBudget = mockClient.complete.mock.calls[0][1];
      expect(tokenBudget).toBe(4096);
    });

    it('returns string on success', async () => {
      mockClient.complete.mockResolvedValue('# Feature: Example');

      const result = await generateSpec(mockClient, 'description');

      expect(typeof result).toBe('string');
    });

    it('returns null on error', async () => {
      mockClient.complete.mockRejectedValue(new Error('Failed'));
      mockWindow.showErrorMessage = vi.fn();

      const result = await generateSpec(mockClient, 'test');

      expect(result).toBeNull();
    });

    it('shows error message on failure', async () => {
      mockClient.complete.mockRejectedValue(new Error('Service error'));
      mockWindow.showErrorMessage = vi.fn();

      await generateSpec(mockClient, 'test');

      expect(mockWindow.showErrorMessage).toHaveBeenCalled();
    });

    it('includes system prompt in client', async () => {
      mockClient.complete.mockResolvedValue('# Spec');

      await generateSpec(mockClient, 'feature');

      expect(mockClient.updateSystemPrompt).toHaveBeenCalledWith(expect.stringContaining('architect'));
    });
  });

  describe('saveSpec', () => {
    it('saves spec to disk', async () => {
      mockWorkspace.fs = {
        createDirectory: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      mockWorkspace.openTextDocument = vi.fn().mockResolvedValue({});
      mockWindow.showTextDocument = vi.fn().mockResolvedValue(undefined);
      mockUri.joinPath = vi.fn((base: any, ...segments: string[]) => ({
        fsPath: base.fsPath + '/' + segments.join('/'),
      }));
      mockUri.file = vi.fn((path: string) => ({ fsPath: path }));

      vi.mocked(getWorkspaceRoot).mockReturnValue('/test/project');

      await saveSpec('Spec Content', 'test-spec', null);

      expect(mockWorkspace.fs.createDirectory).toHaveBeenCalled();
      expect(mockWorkspace.fs.writeFile).toHaveBeenCalled();
    });

    it('sanitizes spec file name', async () => {
      mockWorkspace.fs = {
        createDirectory: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      mockWorkspace.openTextDocument = vi.fn().mockResolvedValue({});
      mockWindow.showTextDocument = vi.fn().mockResolvedValue(undefined);
      mockUri.joinPath = vi.fn((base: any, ...segments: string[]) => ({
        fsPath: base.fsPath + '/' + segments.join('/'),
      }));
      mockUri.file = vi.fn((path: string) => ({ fsPath: path }));

      vi.mocked(getWorkspaceRoot).mockReturnValue('/test/project');

      await saveSpec('Content', 'My Spec With Spaces!', null);

      expect(mockWorkspace.fs.writeFile).toHaveBeenCalled();
      const writeCall = mockWorkspace.fs.writeFile.mock.calls[0];
      const filePath = writeCall[0].fsPath;
      expect(filePath).not.toContain(' ');
      expect(filePath).not.toContain('!');
    });

    it('opens saved spec in editor', async () => {
      mockWorkspace.fs = {
        createDirectory: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      const mockDoc = { uri: { fsPath: '/test/spec.md' } };
      mockWorkspace.openTextDocument = vi.fn().mockResolvedValue(mockDoc);
      mockWindow.showTextDocument = vi.fn().mockResolvedValue(undefined);
      mockUri.joinPath = vi.fn((base: any, ...segments: string[]) => ({
        fsPath: base.fsPath + '/' + segments.join('/'),
      }));
      mockUri.file = vi.fn((path: string) => ({ fsPath: path }));

      vi.mocked(getWorkspaceRoot).mockReturnValue('/test/project');

      await saveSpec('Test Spec', 'test', null);

      expect(mockWindow.showTextDocument).toHaveBeenCalled();
    });

    it('encodes spec content as UTF-8', async () => {
      mockWorkspace.fs = {
        createDirectory: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      mockWorkspace.openTextDocument = vi.fn().mockResolvedValue({});
      mockWindow.showTextDocument = vi.fn().mockResolvedValue(undefined);
      mockUri.joinPath = vi.fn((base: any, ...segments: string[]) => ({
        fsPath: base.fsPath + '/' + segments.join('/'),
      }));
      mockUri.file = vi.fn((path: string) => ({ fsPath: path }));

      vi.mocked(getWorkspaceRoot).mockReturnValue('/test/project');

      const specContent = 'Feature: Unicode ñ';
      await saveSpec(specContent, 'test', null);

      expect(mockWorkspace.fs.writeFile).toHaveBeenCalled();
      const writeCall = mockWorkspace.fs.writeFile.mock.calls[0];
      expect(writeCall[1]).toBeDefined(); // encoded content
    });

    it('uses markdown extension', async () => {
      mockWorkspace.fs = {
        createDirectory: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      mockWorkspace.openTextDocument = vi.fn().mockResolvedValue({});
      mockWindow.showTextDocument = vi.fn().mockResolvedValue(undefined);
      mockUri.joinPath = vi.fn((base: any, ...segments: string[]) => ({
        fsPath: base.fsPath + '/' + segments.join('/'),
      }));
      mockUri.file = vi.fn((path: string) => ({ fsPath: path }));

      vi.mocked(getWorkspaceRoot).mockReturnValue('/test/project');

      await saveSpec('Test', 'myspec', null);

      expect(mockWorkspace.fs.writeFile).toHaveBeenCalled();
      const writeCall = mockWorkspace.fs.writeFile.mock.calls[0];
      const filePath = writeCall[0].fsPath;
      expect(filePath).toContain('.md');
    });

    it('handles file write errors', async () => {
      mockWorkspace.fs = {
        createDirectory: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockRejectedValue(new Error('Write permission denied')),
      };
      mockUri.joinPath = vi.fn((base: any, ...segments: string[]) => ({
        fsPath: base.fsPath + '/' + segments.join('/'),
      }));
      mockUri.file = vi.fn((path: string) => ({ fsPath: path }));

      vi.mocked(getWorkspaceRoot).mockReturnValue('/test/project');

      await expect(saveSpec('Test', 'test', null)).rejects.toThrow();
    });

    it('handles directory creation errors', async () => {
      mockWorkspace.fs = {
        createDirectory: vi.fn().mockRejectedValue(new Error('Cannot create directory')),
      };
      mockUri.file = vi.fn((path: string) => ({ fsPath: path }));

      vi.mocked(getWorkspaceRoot).mockReturnValue('/test/project');

      await expect(saveSpec('Test', 'test', null)).rejects.toThrow();
    });

    it('supports custom spec names', async () => {
      mockWorkspace.fs = {
        createDirectory: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      mockWorkspace.openTextDocument = vi.fn().mockResolvedValue({});
      mockWindow.showTextDocument = vi.fn().mockResolvedValue(undefined);
      mockUri.joinPath = vi.fn((base: any, ...segments: string[]) => ({
        fsPath: base.fsPath + '/' + segments.join('/'),
      }));
      mockUri.file = vi.fn((path: string) => ({ fsPath: path }));

      vi.mocked(getWorkspaceRoot).mockReturnValue('/test/project');

      const customName = 'my-custom-spec-name';
      await saveSpec('Content', customName, null);

      expect(mockWorkspace.fs.writeFile).toHaveBeenCalled();
      const writeCall = mockWorkspace.fs.writeFile.mock.calls[0];
      const filePath = writeCall[0].fsPath;
      expect(filePath).toContain(customName);
    });
  });
});
