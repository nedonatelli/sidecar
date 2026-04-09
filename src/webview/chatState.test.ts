import { describe, it, expect, vi } from 'vitest';
import { ChatState } from './chatState.js';
import type { ExtensionContext } from 'vscode';
import type { TerminalManager } from '../terminal/manager.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';

// Minimal mocks for constructor dependencies
const mockWorkspaceState = {
  get: vi.fn().mockReturnValue([]),
  update: vi.fn(),
};
const mockGlobalState = {
  get: vi.fn().mockReturnValue([]),
  update: vi.fn(),
  keys: vi.fn().mockReturnValue([]),
  setKeysForSync: vi.fn(),
};
const mockContext = {
  workspaceState: mockWorkspaceState,
  globalState: mockGlobalState,
  extensionUri: { fsPath: '/mock' },
  subscriptions: [],
} as unknown as ExtensionContext;

const mockTerminalManager = { executeCommand: vi.fn() } as unknown as TerminalManager;
const mockAgentLogger = { logIteration: vi.fn() } as unknown as AgentLogger;
const mockMcpManager = {} as unknown as MCPManager;
const mockPostMessage = vi.fn();

function createState(): ChatState {
  return new ChatState(mockContext, mockTerminalManager, mockAgentLogger, mockMcpManager, mockPostMessage);
}

describe('ChatState', () => {
  it('initializes with empty messages', () => {
    const state = createState();
    expect(state.messages).toEqual([]);
    expect(state.pendingPlan).toBeNull();
    expect(state.pendingPlanMessages).toEqual([]);
    expect(state.abortController).toBeNull();
  });

  it('delegates postMessage to the callback', () => {
    mockPostMessage.mockClear();
    const state = createState();
    state.postMessage({ command: 'done' });
    expect(mockPostMessage).toHaveBeenCalledWith({ command: 'done' });
  });

  it('clearChat resets all state and sends chatCleared', () => {
    mockPostMessage.mockClear();
    const state = createState();
    state.messages = [{ role: 'user', content: 'hello' }];
    state.pendingPlan = 'some plan';
    state.pendingPlanMessages = [{ role: 'user', content: 'plan context' }];

    state.clearChat();

    expect(state.messages).toEqual([]);
    expect(state.pendingPlan).toBeNull();
    expect(state.pendingPlanMessages).toEqual([]);
    expect(mockPostMessage).toHaveBeenCalledWith({ command: 'chatCleared' });
  });

  it('clearChat aborts running agent loop and bumps generation', () => {
    const state = createState();
    state.abortController = new AbortController();
    const abortSpy = vi.spyOn(state.abortController, 'abort');
    const genBefore = state.chatGeneration;

    state.clearChat();

    expect(abortSpy).toHaveBeenCalled();
    expect(state.abortController).toBeNull();
    expect(state.chatGeneration).toBe(genBefore + 1);
  });

  it('abort calls abort on the controller', () => {
    const state = createState();
    state.abortController = new AbortController();
    const abortSpy = vi.spyOn(state.abortController, 'abort');
    state.abort();
    expect(abortSpy).toHaveBeenCalled();
  });

  it('abort is a no-op when no controller exists', () => {
    const state = createState();
    expect(() => state.abort()).not.toThrow();
  });

  it('saveHistory persists serializable messages', () => {
    mockWorkspaceState.update.mockClear();
    const state = createState();
    state.messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    state.saveHistory();
    expect(mockWorkspaceState.update).toHaveBeenCalledWith('sidecar.chatHistory', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('loadHistory returns stored messages', () => {
    const stored = [{ role: 'user', content: 'saved' }];
    mockWorkspaceState.get.mockReturnValueOnce(stored);
    const state = createState();
    expect(state.loadHistory()).toEqual(stored);
  });

  it('loadHistory filters out stale placeholder entries', () => {
    const stored = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '[message with images]' },
      { role: 'assistant', content: 'real response' },
    ];
    mockWorkspaceState.get.mockReturnValueOnce(stored);
    const state = createState();
    expect(state.loadHistory()).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'real response' },
    ]);
  });

  it('creates a local Ollama client by default', () => {
    const state = createState();
    expect(state.client.isLocalOllama()).toBe(true);
  });
});
