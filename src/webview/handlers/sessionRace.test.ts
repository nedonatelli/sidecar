/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '../../ollama/types.js';

// A run cancelled by New chat or Load session can still throw a NON-abort
// error carrying partialMessages -- the loop rethrows the original network
// error when the cancel lands during a transient-retry backoff. The catch then
// merged the dead run's history over the loaded session and autosaved it,
// overwriting the saved session. (#140)

vi.mock('../../agent/tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/tools.js')>()),
  getToolDefinitions: () => [],
  getToolDefinitionsForTier: () => [],
}));
vi.mock('./notebookHandlers.js', () => ({
  isNotebookModeActive: vi.fn().mockReturnValue(false),
  getNotebookRequireCitations: vi.fn().mockReturnValue(false),
  notebookSystemPromptPrefix: vi.fn().mockReturnValue(''),
}));

function memento() {
  const m = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: async (k: string, v: unknown) => {
      m.set(k, v);
    },
    keys: () => [...m.keys()],
  };
}

describe('loading a session during a retry backoff', () => {
  it('keeps the loaded session: the stopped run writes nothing over it', async () => {
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(true);
    const settingsMod = await import('../../config/settings.js');
    const real = settingsMod.getConfig();
    vi.spyOn(settingsMod, 'getConfig').mockReturnValue({
      ...real,
      dailyBudget: 0,
      weeklyBudget: 0,
      model: 'test-model',
      baseUrl: 'http://localhost',
      apiKey: '',
      agentMode: 'autonomous',
      customModes: [],
      shadowWorkspaceMode: 'off',
      adaptiveScaffoldingEnabled: false,
    } as never);
    vi.spyOn(settingsMod, 'identifyOllamaServer').mockResolvedValue(undefined as never);
    const sp = await import('./systemPrompt.js');
    vi.spyOn(sp, 'injectSystemContext').mockResolvedValue({ prompt: 'sys', matchedSkill: null } as never);
    vi.spyOn(sp, 'enrichAndPruneMessages').mockResolvedValue(undefined as never);

    const { ChatState } = await import('../chatState.js');
    const { handleUserMessage } = await import('./chatHandlers.js');
    const { handleLoadSession } = await import('./sessionHandlers.js');
    const context = { globalState: memento(), workspaceState: memento(), extension: { packageJSON: {} } };
    const posted: any[] = [];
    const state = new ChatState(context as any, {} as any, undefined as any, undefined as any, (m: any) =>
      posted.push(m),
    );
    let streamCalls = 0;
    state.client = {
      getProviderType: () => 'anthropic',
      isLocalOllama: () => false,
      isLocalEndpoint: () => false,
      setTurnOverride: () => {},
      updateConnection: () => {},
      updateModel: () => {},
      updateSystemPrompt: () => {},
      getModelContextLength: async () => null,
      getModel: () => 'test-model',
      getSystemPrompt: () => 'sys',
      getRouter: () => null,
      streamChat: async function* (): AsyncGenerator<StreamEvent> {
        streamCalls++;
        throw new Error('fetch failed');
      },
    } as any;

    // A short saved session the user wants to go back to.
    const saved = state.sessionManager.save('design notes', [
      { role: 'user', content: 'KEEP: design notes' },
      { role: 'assistant', content: 'KEEP: saved answer' },
    ]);
    state.messages = [
      { role: 'user', content: 'current task context' },
      { role: 'assistant', content: 'current answer' },
    ];
    const run = handleUserMessage(state as any, 'refactor the parser');
    await vi.waitFor(() => expect(streamCalls).toBe(1));
    await new Promise((r) => setTimeout(r, 100));

    handleLoadSession(state as any, saved.id);
    expect(JSON.stringify(state.messages)).toContain('KEEP: design notes');
    const loadedAt = posted.length;

    await run;

    const after = state.sessionManager.load(saved.id)!;
    expect(JSON.stringify(after.messages)).toContain('KEEP: design notes');
    expect(JSON.stringify(after.messages)).not.toContain('current task context');
    expect(JSON.stringify(state.messages)).toContain('KEEP: design notes');
    expect(state.currentSessionId).toBe(saved.id);
    // ...and the stopped run's error card does not land in it.
    expect(posted.slice(loadedAt).filter((m) => m.command === 'error')).toEqual([]);
    vi.restoreAllMocks();
  }, 20_000);
});
