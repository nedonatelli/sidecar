import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSaveSession, handleLoadSession, handleDeleteSession, handleListSessions } from './sessionHandlers.js';
import { window } from 'vscode';

function createMockState() {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    postMessage: vi.fn(),
    saveHistory: vi.fn(),
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
      const session = { messages: [{ role: 'assistant', content: 'loaded' }] };
      state.sessionManager.load.mockReturnValue(session);

      handleLoadSession(state as never, 'session-1');
      expect(state.messages).toEqual(session.messages);
      expect(state.saveHistory).toHaveBeenCalled();
      expect(state.postMessage).toHaveBeenCalledWith({ command: 'chatCleared' });
      expect(state.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'init', messages: session.messages }),
      );
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
