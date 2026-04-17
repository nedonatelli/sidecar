import { describe, it, expect, vi } from 'vitest';
import { SideCarCompletionProvider } from './provider.js';
import { InlineCompletionTriggerKind, Position, Range } from 'vscode';

function mockClient(overrides: Record<string, unknown> = {}) {
  return {
    isLocalOllama: vi.fn().mockReturnValue(true),
    completeFIM: vi.fn().mockResolvedValue('completion text'),
    complete: vi.fn().mockResolvedValue('completion text'),
    completeWithOverrides: vi.fn().mockResolvedValue('completion text'),
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
    // v0.62.2 q.2b — non-Ollama now routes through completeWithOverrides
    // so the system prompt can live in its own cache-markable slot.
    expect(client.completeWithOverrides).toHaveBeenCalled();
    provider.dispose();
  });

  describe('cache-friendly prompt structure (v0.62.2 q.2b)', () => {
    it('sends the system preamble in the systemPrompt arg, not the user message', async () => {
      const client = mockClient({ isLocalOllama: vi.fn().mockReturnValue(false) });
      const provider = new SideCarCompletionProvider(client as never, 256, 0);
      const doc = mockDocument('const longEnoughPrefix = true;\n');
      await provider.provideInlineCompletionItems(
        doc as never,
        new Position(1, 0),
        { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
        mockToken() as never,
      );
      expect(client.completeWithOverrides).toHaveBeenCalled();
      const [systemPrompt, messages] = (client.completeWithOverrides as ReturnType<typeof vi.fn>).mock.calls[0];
      // System prompt contains the cacheable preamble…
      expect(systemPrompt).toContain('code completion engine');
      expect(systemPrompt).toContain('<CURSOR>');
      // …and the user message contains ONLY the variable bits — no
      // preamble duplication. If the preamble leaked into the user
      // message, prompt caching would miss on every call.
      const userContent = (messages[0] as { content: string }).content;
      expect(userContent).not.toContain('code completion engine');
      expect(userContent).toContain('<CURSOR>');
    });

    it('system prompt is byte-for-byte identical across different languages', async () => {
      // Prompt caching keys on the EXACT system-block bytes — any
      // per-call variation (language name in the preamble, etc.)
      // defeats it. Language hint belongs in the user message.
      const client = mockClient({ isLocalOllama: vi.fn().mockReturnValue(false) });
      const provider = new SideCarCompletionProvider(client as never, 256, 0);
      const tsDoc = mockDocument('const longEnoughPrefix = true;\n');
      (tsDoc as never as { languageId: string }).languageId = 'typescript';
      const pyDoc = mockDocument('def long_enough_prefix():\n    return True\n');
      (pyDoc as never as { languageId: string }).languageId = 'python';

      await provider.provideInlineCompletionItems(
        tsDoc as never,
        new Position(1, 0),
        { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
        mockToken() as never,
      );
      await provider.provideInlineCompletionItems(
        pyDoc as never,
        new Position(2, 0),
        { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
        mockToken() as never,
      );

      const calls = (client.completeWithOverrides as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      // Same systemPrompt across both calls — prompt cache hits from call 2 onward.
      expect(calls[0][0]).toBe(calls[1][0]);
      // Language hint is in the user message instead.
      expect((calls[0][1][0] as { content: string }).content).toContain('typescript');
      expect((calls[1][1][0] as { content: string }).content).toContain('python');
    });
  });

  describe('latency telemetry (v0.62.2 q.2c)', () => {
    it('logs per-completion timing with the path label', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const provider = new SideCarCompletionProvider(mockClient() as never, 256, 0);
        const doc = mockDocument('const longEnoughPrefix = true;\n');
        await provider.provideInlineCompletionItems(
          doc as never,
          new Position(1, 0),
          { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
          mockToken() as never,
        );
        const logLines = infoSpy.mock.calls.map((c) => c[0] as string);
        const completionLog = logLines.find((l) => l.includes('Inline completion'));
        expect(completionLog).toBeDefined();
        expect(completionLog).toContain('[ollama-fim]');
        expect(completionLog).toMatch(/\d+ms/);
        provider.dispose();
      } finally {
        infoSpy.mockRestore();
      }
    });

    it('logs failure timing but NOT cancellation timing', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const client = mockClient({
          completeFIM: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'NetworkError' })),
        });
        const provider = new SideCarCompletionProvider(client as never, 256, 0);
        const doc = mockDocument('const longEnoughPrefix = true;\n');
        await provider.provideInlineCompletionItems(
          doc as never,
          new Position(1, 0),
          { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
          mockToken() as never,
        );
        const failLog = infoSpy.mock.calls.map((c) => c[0] as string).find((l) => l.includes('failed'));
        expect(failLog).toBeDefined();
        expect(failLog).toContain('boom');
        provider.dispose();

        infoSpy.mockClear();

        // Now an AbortError — should NOT log (cancellations are noise).
        const abortClient = mockClient({
          completeFIM: vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        });
        const provider2 = new SideCarCompletionProvider(abortClient as never, 256, 0);
        await provider2.provideInlineCompletionItems(
          doc as never,
          new Position(1, 0),
          { triggerKind: InlineCompletionTriggerKind.Invoke } as never,
          mockToken() as never,
        );
        const afterAbort = infoSpy.mock.calls.map((c) => c[0] as string).find((l) => l.includes('failed'));
        expect(afterAbort).toBeUndefined();
        provider2.dispose();
      } finally {
        infoSpy.mockRestore();
      }
    });
  });
});
