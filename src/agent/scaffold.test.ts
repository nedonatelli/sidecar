import { describe, it, expect, vi } from 'vitest';
import { getTemplateList, generateScaffold } from './scaffold.js';
import type { SideCarClient } from '../ollama/client.js';

describe('scaffold', () => {
  it('getTemplateList returns available templates', () => {
    const list = getTemplateList();
    expect(typeof list).toBe('string');
    expect(list.length).toBeGreaterThan(0);
    // Should mention common template types
    expect(list.toLowerCase()).toContain('component');
  });

  it('getTemplateList includes all 8 template types', () => {
    const list = getTemplateList();
    for (const name of ['component', 'api', 'test', 'model', 'cli', 'hook', 'middleware', 'service']) {
      expect(list).toContain(name);
    }
  });
});

describe('generateScaffold', () => {
  it('returns generated code from the client', async () => {
    const mockClient = {
      updateSystemPrompt: vi.fn(),
      complete: vi.fn().mockResolvedValue('function MyComponent() { return null; }'),
    } as unknown as SideCarClient;

    const result = await generateScaffold(mockClient, 'component', 'a simple counter', 'TypeScript');
    expect(mockClient.updateSystemPrompt).toHaveBeenCalled();
    expect(mockClient.complete).toHaveBeenCalled();
    expect(result).toContain('MyComponent');
  });

  it('strips markdown code fences from the result', async () => {
    const mockClient = {
      updateSystemPrompt: vi.fn(),
      complete: vi.fn().mockResolvedValue('```typescript\nconst x = 1;\n```'),
    } as unknown as SideCarClient;

    const result = await generateScaffold(mockClient, 'service', '', 'TypeScript');
    expect(result).not.toContain('```');
    expect(result).toContain('const x = 1;');
  });

  it('returns null when client.complete throws', async () => {
    const mockClient = {
      updateSystemPrompt: vi.fn(),
      complete: vi.fn().mockRejectedValue(new Error('LLM error')),
    } as unknown as SideCarClient;

    const result = await generateScaffold(mockClient, 'api', '', 'TypeScript');
    expect(result).toBeNull();
  });

  it('uses a generic prompt for unknown template types', async () => {
    const mockClient = {
      updateSystemPrompt: vi.fn(),
      complete: vi.fn().mockResolvedValue('// custom code'),
    } as unknown as SideCarClient;

    const result = await generateScaffold(mockClient, 'custom-unknown-type', 'my thing', 'JavaScript');
    expect(result).not.toBeNull();
    const callArgs = (mockClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const prompt = callArgs[0].content as string;
    expect(prompt).toContain('custom-unknown-type');
  });
});
