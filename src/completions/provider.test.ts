import { describe, it, expect, vi } from 'vitest';
import { SideCarCompletionProvider } from './provider.js';
import { InlineCompletionTriggerKind, Position, Range } from 'vscode';

function mockClient(overrides: Record<string, unknown> = {}) {
  return {
    isLocalOllama: vi.fn().mockReturnValue(true),
    completeFIM: vi.fn().mockResolvedValue('completion text'),
    complete: vi.fn().mockResolvedValue('completion text'),
    ...overrides,
  };
}

function mockDocument(text: string) {
  const lines = text.split('\n');
  return {
    getText: vi.fn((range?: Range) => {
      if (!range) return text;
      // Simplified: return prefix or suffix based on range
      return text;
    }),
    lineAt: (line: number) => ({
      range: { end: new Position(line, (lines[line] || '').length) },
    }),
    lineCount: lines.length,
    fileName: '/project/src/app.ts',
    languageId: 'typescript',
  };
}

function mockToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: vi.fn(),
  };
}

describe('SideCarCompletionProvider', () => {
  it('creates instance without error', () => {
    const provider = new SideCarCompletionProvider(mockClient() as never);
    expect(provider).toBeDefined();
    provider.dispose();
  });

  it('dispose cleans up listener', () => {
    const provider = new SideCarCompletionProvider(mockClient() as never);
    expect(() => provider.dispose()).not.toThrow();
  });

  it('returns empty array when prefix is too short', async () => {
    const provider = new SideCarCompletionProvider(mockClient() as never, 256, 0);
    const doc = mockDocument('x'); // very short
    const result = await provider.provideInlineCompletionItems(
      doc as never,
      new Position(0, 1),
      { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
      mockToken() as never,
    );
    expect(result).toEqual([]);
    provider.dispose();
  });

  it('returns completion items for sufficient prefix', async () => {
    const longText = 'const x = 1;\nconst y = 2;\nfunction hello() {\n  return';
    const provider = new SideCarCompletionProvider(mockClient() as never, 256, 0);
    const doc = mockDocument(longText);
    const result = await provider.provideInlineCompletionItems(
      doc as never,
      new Position(3, 8),
      { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
      mockToken() as never,
    );
    expect(result.length).toBeGreaterThan(0);
    provider.dispose();
  });

  it('handles completion errors gracefully', async () => {
    const client = mockClient({ completeFIM: vi.fn().mockRejectedValue(new Error('timeout')) });
    const provider = new SideCarCompletionProvider(client as never, 256, 0);
    const doc = mockDocument('const longEnoughPrefix = true;\n');
    const result = await provider.provideInlineCompletionItems(
      doc as never,
      new Position(1, 0),
      { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
      mockToken() as never,
    );
    expect(result).toEqual([]);
    provider.dispose();
  });

  it('uses chat completion for non-Ollama providers', async () => {
    const client = mockClient({ isLocalOllama: vi.fn().mockReturnValue(false) });
    const provider = new SideCarCompletionProvider(client as never, 256, 0);
    const doc = mockDocument('const longEnoughPrefix = true;\n');
    await provider.provideInlineCompletionItems(
      doc as never,
      new Position(1, 0),
      { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
      mockToken() as never,
    );
    expect(client.complete).toHaveBeenCalled();
    provider.dispose();
  });
});
