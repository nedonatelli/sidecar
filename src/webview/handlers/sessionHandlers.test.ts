import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSaveSession, handleLoadSession, handleDeleteSession, handleListSessions } from './sessionHandlers.js';
import { window } from 'vscode';

function createMockState() {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    postMessage: vi.fn(),
    saveHistory: vi.fn(),
    autoSave: vi.fn(),
    abort: vi.fn(),
    abortController: null as AbortController | null,
    cancelCallbacks: null as (() => void) | null,
    currentSessionId: null as string | null,
    chatGeneration: 0,
    currentSteerDisposer: null as (() => void) | null,
    currentSteerQueue: null as object | null,
    sessionManager: {
      save: vi.fn(),
      load: vi.fn(),
      delete: vi.fn(),
      list: vi.fn((): { id: string; name: string; createdAt: string; messages: unknown[] }[] => []),
    },
  };
}

describe('sessionHandlers', () => {
  let state: ReturnType<typeof createMockState>;

  beforeEach(() => {
    vi.restoreAllMocks();
    state = createMockState();
  });

  describe('handleSaveSession', () => {
    it('saves session and shows notification', () => {
      const infoSpy = vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
      handleSaveSession(state as never, 'my-session');
      expect(state.sessionManager.save).toHaveBeenCalledWith('my-session', state.messages);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('my-session'));
    });

    it('refreshes session list after save', () => {
      vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
      handleSaveSession(state as never, 'test');
      expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'sessionList' }));
    });
  });

  describe('handleLoadSession', () => {
    it('loads session and updates state', () => {
      const session = { id: 'session-1', messages: [{ role: 'assistant', content: 'loaded' }] };
      state.sessionManager.load.mockReturnValue(session);

      handleLoadSession(state as never, 'session-1');
      expect(state.autoSave).toHaveBeenCalled();
      expect(state.messages).toEqual(session.messages);
      expect(state.currentSessionId).toBe('session-1');
      expect(state.saveHistory).toHaveBeenCalled();
      expect(state.postMessage).toHaveBeenCalledWith({ command: 'chatCleared' });
      expect(state.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'init', messages: session.messages }),
      );
    });

    it('bumps chatGeneration so a completing loop cannot overwrite the loaded session', () => {
      const session = { id: 's1', messages: [] };
      state.sessionManager.load.mockReturnValue(session);
      const before = state.chatGeneration;
      handleLoadSession(state as never, 's1');
      expect(state.chatGeneration).toBeGreaterThan(before);
    });

    it('disposes the steer listener and posts steerEnabled:false before replacing messages', () => {
      const session = { id: 's1', messages: [{ role: 'user', content: 'loaded' }] };
      state.sessionManager.load.mockReturnValue(session);
      const disposer = vi.fn();
      state.currentSteerDisposer = disposer;
      state.currentSteerQueue = { serialize: vi.fn().mockReturnValue([]) };

      handleLoadSession(state as never, 's1');

      expect(disposer).toHaveBeenCalled();
      expect(state.currentSteerDisposer).toBeNull();
      expect(state.currentSteerQueue).toBeNull();
      // steerEnabled:false must be posted BEFORE the init message so the
      // webview never briefly shows the steer strip open on the new session.
      const calls = state.postMessage.mock.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
      const steerIdx = calls.indexOf('steerQueueUpdate');
      const initIdx = calls.indexOf('init');
      expect(steerIdx).toBeGreaterThanOrEqual(0);
      expect(steerIdx).toBeLessThan(initIdx);
    });

    it('does nothing when session not found', () => {
      state.sessionManager.load.mockReturnValue(null);

      handleLoadSession(state as never, 'nonexistent');
      expect(state.saveHistory).not.toHaveBeenCalled();
      expect(state.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleDeleteSession', () => {
    it('deletes session and refreshes list', () => {
      handleDeleteSession(state as never, 'session-1');
      expect(state.sessionManager.delete).toHaveBeenCalledWith('session-1');
      expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'sessionList' }));
    });
  });

  describe('handleListSessions', () => {
    it('sends serialized session list', () => {
      state.sessionManager.list.mockReturnValue([
        { id: '1', name: 'First', createdAt: '2026-04-05', messages: [] },
        { id: '2', name: 'Second', createdAt: '2026-04-05', messages: [] },
      ]);

      handleListSessions(state as never);
      expect(state.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'sessionList',
          content: expect.stringContaining('"name":"First"'),
        }),
      );
    });
  });
});
