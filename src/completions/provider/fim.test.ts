import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SideCarClient } from '../../ollama/client.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('vscode', () => ({
  InlineCompletionItem: class {
    constructor(
      public insertText: string,
      public range: unknown,
    ) {}
  },
  InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  workspace: {
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../../config/constants.js', () => ({
  lookupDraftModel: vi.fn(),
}));

vi.mock('../debounce.js', () => ({
  Debouncer: class {
    shouldTrigger() {
      return true;
    }
    getSignal() {
      return new AbortController().signal;
    }
    cancel() {}
  },
}));

vi.mock('./shared.js', () => ({
  PredictiveContext: class {
    track() {}
    buildRecentEditContext() {
      return '';
    }
    buildCompletionUserMessage() {
      return 'user msg';
    }
    static cleanCompletion(c: string) {
      return c;
    }
  },
  MIN_PREFIX_LENGTH: 3,
  MAX_PREFIX_CHARS: 10000,
  MAX_SUFFIX_CHARS: 10000,
  COMPLETION_SYSTEM_PROMPT: 'sys',
}));

import { getConfig } from '../../config/settings.js';
import { lookupDraftModel } from '../../config/constants.js';
import { SideCarCompletionProvider } from './fim.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(
  overrides: Partial<{
    isLocalOllama: boolean;
    providerType: string;
    model: string;
    completeFIMResult: string;
  }> = {},
): SideCarClient {
  const opts = {
    isLocalOllama: true,
    providerType: 'ollama',
    model: 'qwen2.5-coder:32b',
    completeFIMResult: 'completion text',
    ...overrides,
  };
  return {
    isLocalOllama: () => opts.isLocalOllama,
    getProviderType: () => opts.providerType,
    getModel: () => opts.model,
    routeForDispatch: vi.fn(),
    completeFIM: vi.fn().mockResolvedValue(opts.completeFIMResult),
    completeWithOverrides: vi.fn().mockResolvedValue(''),
  } as unknown as SideCarClient;
}

function makeDocument(content = 'hello world ') {
  const lines = content.split('\n');
  return {
    getText: (_range?: unknown) => content,
    languageId: 'typescript',
    fileName: 'test.ts',
    lineCount: lines.length,
    lineAt: (n: number) => ({ range: { end: { line: n, character: lines[n]?.length ?? 0 } } }),
  };
}

function makePosition(line = 0, character = 12) {
  return { line, character };
}

function makeToken(isCancelled = false) {
  const listeners: (() => void)[] = [];
  return {
    isCancellationRequested: isCancelled,
    onCancellationRequested: (fn: () => void) => {
      listeners.push(fn);
      return { dispose: vi.fn() };
    },
  };
}

function makeContext() {
  return { triggerKind: 1 }; // Automatic
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    completionDraftModel: '',
    speculativeDecoding: { enabled: true, minAcceptRateToKeepEnabled: 0.4 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SideCarCompletionProvider', () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue(baseConfig() as ReturnType<typeof getConfig>);
    vi.mocked(lookupDraftModel).mockReturnValue(undefined);
  });

  it('uses a direct FIM call when no draft is configured and no map entry exists', async () => {
    const client = makeClient();
    const provider = new SideCarCompletionProvider(client, 64, 0);

    const items = await provider.provideInlineCompletionItems(
      makeDocument() as never,
      makePosition() as never,
      makeContext() as never,
      makeToken() as never,
    );

    expect(client.completeFIM).toHaveBeenCalledOnce();
    // Called without an explicit draft model (model arg is undefined)
    expect(vi.mocked(client.completeFIM).mock.calls[0][2]).toBeUndefined();
    expect(items).toHaveLength(1);
  });

  it('races against auto-discovered draft when DRAFT_MODEL_MAP has an entry', async () => {
    vi.mocked(lookupDraftModel).mockReturnValue('qwen2.5-coder:0.5b');
    const client = makeClient();
    const provider = new SideCarCompletionProvider(client, 64, 0);

    await provider.provideInlineCompletionItems(
      makeDocument() as never,
      makePosition() as never,
      makeContext() as never,
      makeToken() as never,
    );

    // Two calls: one for the draft, one for the target
    expect(vi.mocked(client.completeFIM).mock.calls.length).toBeGreaterThanOrEqual(1);
    const modelArgs = vi.mocked(client.completeFIM).mock.calls.map((c) => c[2]);
    expect(modelArgs).toContain('qwen2.5-coder:0.5b');
  });

  it('uses the explicit completionDraftModel over auto-discovery', async () => {
    vi.mocked(getConfig).mockReturnValue(
      baseConfig({ completionDraftModel: 'my-custom-draft:1b' }) as ReturnType<typeof getConfig>,
    );
    vi.mocked(lookupDraftModel).mockReturnValue('qwen2.5-coder:0.5b');
    const client = makeClient();
    const provider = new SideCarCompletionProvider(client, 64, 0);

    await provider.provideInlineCompletionItems(
      makeDocument() as never,
      makePosition() as never,
      makeContext() as never,
      makeToken() as never,
    );

    const modelArgs = vi.mocked(client.completeFIM).mock.calls.map((c) => c[2]);
    expect(modelArgs).toContain('my-custom-draft:1b');
    // auto-discovered draft should NOT be used when explicit draft is set
    expect(modelArgs).not.toContain('qwen2.5-coder:0.5b');
  });

  it('skips racing when speculativeDecoding.enabled is false', async () => {
    vi.mocked(getConfig).mockReturnValue(
      baseConfig({ speculativeDecoding: { enabled: false, minAcceptRateToKeepEnabled: 0.4 } }) as ReturnType<
        typeof getConfig
      >,
    );
    vi.mocked(lookupDraftModel).mockReturnValue('qwen2.5-coder:0.5b');
    const client = makeClient();
    const provider = new SideCarCompletionProvider(client, 64, 0);

    await provider.provideInlineCompletionItems(
      makeDocument() as never,
      makePosition() as never,
      makeContext() as never,
      makeToken() as never,
    );

    expect(client.completeFIM).toHaveBeenCalledOnce();
    expect(vi.mocked(client.completeFIM).mock.calls[0][2]).toBeUndefined();
  });

  it('supports Kickstand provider in the racing path', async () => {
    vi.mocked(lookupDraftModel).mockReturnValue('qwen2.5-coder:0.5b');
    const client = makeClient({ isLocalOllama: false, providerType: 'kickstand' });
    const provider = new SideCarCompletionProvider(client, 64, 0);

    await provider.provideInlineCompletionItems(
      makeDocument() as never,
      makePosition() as never,
      makeContext() as never,
      makeToken() as never,
    );

    const modelArgs = vi.mocked(client.completeFIM).mock.calls.map((c) => c[2]);
    expect(modelArgs).toContain('qwen2.5-coder:0.5b');
  });

  it('auto-disables speculative decoding when draft win rate drops below threshold', async () => {
    vi.mocked(lookupDraftModel).mockReturnValue('draft:1b');
    // Draft always loses — completeFIM for draft returns empty, target returns text
    const client = makeClient();
    vi.mocked(client.completeFIM).mockImplementation((_p, _s, model) => {
      if (model === 'draft:1b') {
        // Simulate draft being slow — resolve after a small delay so target wins
        return new Promise((res) => setTimeout(() => res(''), 50));
      }
      return Promise.resolve('target result');
    });

    const provider = new SideCarCompletionProvider(client, 64, 0);
    const doc = makeDocument() as never;
    const pos = makePosition() as never;
    const ctx = makeContext() as never;

    // Run enough completions to exhaust the warmup window (10)
    for (let i = 0; i < 12; i++) {
      await provider.provideInlineCompletionItems(doc, pos, ctx, makeToken() as never);
    }

    // After auto-disable, the next call should NOT race (only one completeFIM call with undefined model)
    const prevCalls = vi.mocked(client.completeFIM).mock.calls.length;
    await provider.provideInlineCompletionItems(doc, pos, ctx, makeToken() as never);
    const newCalls = vi.mocked(client.completeFIM).mock.calls.length - prevCalls;
    // Should be exactly 1 call (no racing), called without a draft model
    expect(newCalls).toBe(1);
    expect(vi.mocked(client.completeFIM).mock.calls.at(-1)?.[2]).toBeUndefined();
  });
});
