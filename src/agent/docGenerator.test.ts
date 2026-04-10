/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDocumentation } from './docGenerator.js';
import type { SideCarClient } from '../ollama/client.js';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
  },
}));

describe('docGenerator', () => {
  let mockClient: Partial<SideCarClient>;

  beforeEach(() => {
    mockClient = {
      updateSystemPrompt: vi.fn(),
      complete: vi.fn(),
    };
    vi.clearAllMocks();
  });

  it('generates documentation for code', async () => {
    const code = 'function add(a, b) { return a + b; }';
    vi.mocked((mockClient as any).complete).mockResolvedValue(
      '/** Adds two numbers */ function add(a, b) { return a + b; }',
    );

    const result = await generateDocumentation(mockClient as SideCarClient, code, 'javascript', 'math.js');

    expect(result).toContain('function add');
    expect(vi.mocked((mockClient as any).updateSystemPrompt)).toHaveBeenCalled();
    expect(vi.mocked((mockClient as any).complete)).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('javascript'),
        }),
      ]),
      expect.any(Number),
    );
  });

  it('strips code fence wrappers from output', async () => {
    const code = 'const x = 1;';
    vi.mocked((mockClient as any).complete).mockResolvedValue('```javascript\n/* Constant x */ const x = 1;\n```');

    const result = await generateDocumentation(mockClient as SideCarClient, code, 'javascript', 'test.js');

    expect(result).not.toContain('```');
    expect(result).toContain('const x = 1');
  });

  it('handles generation errors gracefully', async () => {
    const code = 'function f() {}';
    const error = new Error('API error');
    vi.mocked((mockClient as any).complete).mockRejectedValue(error);

    const result = await generateDocumentation(mockClient as SideCarClient, code, 'javascript', 'test.js');

    expect(result).toBeNull();
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalledWith(
      expect.stringContaining('Documentation generation failed'),
    );
  });

  it('sets correct system prompt for documentation task', async () => {
    vi.mocked((mockClient as any).complete).mockResolvedValue('documented code');

    await generateDocumentation(mockClient as SideCarClient, 'code', 'typescript', 'file.ts');

    const updateCall = vi.mocked((mockClient as any).updateSystemPrompt).mock.calls[0];
    expect(updateCall[0]).toContain('documentation generator');
    expect(updateCall[0]).toContain('JSDoc');
  });

  it('includes filename in message', async () => {
    vi.mocked((mockClient as any).complete).mockResolvedValue('result');

    await generateDocumentation(mockClient as SideCarClient, 'code', 'python', 'utils.py');

    const completeCall = vi.mocked((mockClient as any).complete).mock.calls[0];
    const message = completeCall[0][0];
    expect((message as any).content).toContain('utils.py');
  });

  it('requests appropriate token budget', async () => {
    vi.mocked((mockClient as any).complete).mockResolvedValue('result');

    await generateDocumentation(mockClient as SideCarClient, 'code', 'javascript', 'test.js');

    const completeCall = vi.mocked((mockClient as any).complete).mock.calls[0];
    const tokenBudget = completeCall[1];
    expect(tokenBudget).toBeGreaterThan(1000);
  });

  it('handles non-Error exceptions', async () => {
    const code = 'code';
    vi.mocked((mockClient as any).complete).mockRejectedValue('string error');

    const result = await generateDocumentation(mockClient as SideCarClient, code, 'javascript', 'test.js');

    expect(result).toBeNull();
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it('handles empty code fence', async () => {
    const code = 'const f = () => {}';
    vi.mocked((mockClient as any).complete).mockResolvedValue('```\ncode\n```');

    const result = await generateDocumentation(mockClient as SideCarClient, code, 'javascript', 'test.js');

    expect(result).toBe('code');
  });
});
