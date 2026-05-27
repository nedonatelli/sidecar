import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleSaveSession,
  handleLoadSession,
  handleDeleteSession,
  handleListSessions,
  handleBranchSession,
  handleResearchCommand,
} from './sessionHandlers.js';
import { window, workspace } from 'vscode';

vi.mock('../../agent/tools/research.js', () => ({
  getResearchStore: vi.fn(),
}));

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(() => ({ researchActiveProject: '' })),
}));

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
      branch: vi.fn(),
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

describe('handleBranchSession', () => {
  let state: ReturnType<typeof createMockState>;

  beforeEach(() => {
    vi.restoreAllMocks();
    state = createMockState();
  });

  it('branches from existing session when parentId is set', async () => {
    state.currentSessionId = 'parent-id';
    state.sessionManager.branch.mockReturnValue({ id: 'child-id' });

    await handleBranchSession(state as never, 'new-branch');

    expect(state.autoSave).toHaveBeenCalled();
    expect(state.sessionManager.branch).toHaveBeenCalledWith('parent-id', 'new-branch', state.messages);
    expect(state.currentSessionId).toBe('child-id');
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'threadSwitched' }));
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'sessionList' }));
  });

  it('saves an original then branches when no currentSessionId', async () => {
    state.currentSessionId = null;
    const parent = { id: 'orig-id' };
    const child = { id: 'branch-id' };
    state.sessionManager.save.mockReturnValue(parent);
    state.sessionManager.branch.mockReturnValue(child);

    await handleBranchSession(state as never, 'try-alt');

    expect(state.sessionManager.save).toHaveBeenCalledWith('try-alt (original)', state.messages);
    expect(state.sessionManager.branch).toHaveBeenCalledWith('orig-id', 'try-alt', state.messages);
    expect(state.currentSessionId).toBe('branch-id');
  });

  it('prompts for a name when none supplied', async () => {
    state.currentSessionId = 'p';
    state.sessionManager.branch.mockReturnValue({ id: 'c' });
    vi.spyOn(window, 'showInputBox').mockResolvedValue('prompted-name');

    await handleBranchSession(state as never);

    expect(window.showInputBox).toHaveBeenCalled();
    expect(state.sessionManager.branch).toHaveBeenCalledWith('p', 'prompted-name', state.messages);
  });

  it('returns early when prompt is cancelled', async () => {
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined);

    await handleBranchSession(state as never);

    expect(state.sessionManager.branch).not.toHaveBeenCalled();
    expect(state.postMessage).not.toHaveBeenCalled();
  });
});

describe('handleResearchCommand', () => {
  let state: ReturnType<typeof createMockState>;
  let mockStore: {
    listProjects: ReturnType<typeof vi.fn>;
    loadProject: ReturnType<typeof vi.fn>;
    listExperiments: ReturnType<typeof vi.fn>;
    listObservations: ReturnType<typeof vi.fn>;
    addObservation: ReturnType<typeof vi.fn>;
    generateReport: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    state = createMockState();
    mockStore = {
      listProjects: vi.fn().mockResolvedValue([]),
      loadProject: vi.fn().mockResolvedValue(null),
      listExperiments: vi.fn().mockResolvedValue([]),
      listObservations: vi.fn().mockResolvedValue([]),
      addObservation: vi.fn(),
      generateReport: vi.fn().mockResolvedValue(null),
    };
    const { getResearchStore } = await import('../../agent/tools/research.js');
    vi.mocked(getResearchStore).mockReturnValue(mockStore as never);
  });

  it('posts disabled message when store is null', async () => {
    const { getResearchStore } = await import('../../agent/tools/research.js');
    vi.mocked(getResearchStore).mockReturnValue(null);

    await handleResearchCommand(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('disabled') }),
    );
    expect(state.postMessage).toHaveBeenCalledWith({ command: 'done' });
  });

  it('observe: records observation when active project is set', async () => {
    const { getConfig } = await import('../../config/settings.js');
    vi.mocked(getConfig).mockReturnValue({ researchActiveProject: 'my-project' } as never);
    const obs = { timestamp: Date.now(), note: 'test note' };
    mockStore.addObservation.mockResolvedValue(obs);

    await handleResearchCommand(state as never, 'observe test note');

    expect(mockStore.addObservation).toHaveBeenCalledWith('my-project', 'test note');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('Observation recorded'),
      }),
    );
    expect(state.postMessage).toHaveBeenCalledWith({ command: 'done' });
  });

  it('observe: posts error when no active project', async () => {
    const { getConfig } = await import('../../config/settings.js');
    vi.mocked(getConfig).mockReturnValue({ researchActiveProject: '' } as never);
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({ get: vi.fn().mockReturnValue('') } as never);

    await handleResearchCommand(state as never, 'observe some note');

    expect(mockStore.addObservation).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('No active research project'),
      }),
    );
  });

  it('report: posts report content for existing project', async () => {
    const { getConfig } = await import('../../config/settings.js');
    vi.mocked(getConfig).mockReturnValue({ researchActiveProject: 'proj' } as never);
    mockStore.generateReport.mockResolvedValue({ markdown: '# Report', filePath: '/tmp/report.md' });

    await handleResearchCommand(state as never, 'report');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('Report saved to') }),
    );
  });

  it('report: posts no-project error when no active project', async () => {
    const { getConfig } = await import('../../config/settings.js');
    vi.mocked(getConfig).mockReturnValue({ researchActiveProject: '' } as never);
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({ get: vi.fn().mockReturnValue('') } as never);

    await handleResearchCommand(state as never, 'report');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('No active research project'),
      }),
    );
  });

  it('status: prints project summary with hypotheses and counts', async () => {
    const { getConfig } = await import('../../config/settings.js');
    vi.mocked(getConfig).mockReturnValue({ researchActiveProject: 'proj' } as never);
    mockStore.loadProject.mockResolvedValue({
      title: 'My Project',
      slug: 'proj',
      status: 'active',
      question: 'Does X work?',
      hypotheses: [{ id: 'h1', text: 'Yes', status: 'open' }],
    });
    mockStore.listExperiments.mockResolvedValue([{ id: 'e1', status: 'pending' }]);
    mockStore.listObservations.mockResolvedValue([{ timestamp: Date.now(), note: 'First observation' }]);

    await handleResearchCommand(state as never, 'status');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('My Project') }),
    );
    expect(state.postMessage).toHaveBeenCalledWith({ command: 'done' });
  });

  it('shows QuickPick when no args and projects exist', async () => {
    mockStore.listProjects.mockResolvedValue([{ title: 'Alpha', slug: 'alpha', status: 'active', hypotheses: [] }]);
    vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined);

    await handleResearchCommand(state as never);

    expect(window.showQuickPick).toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith({ command: 'done' });
  });

  it('posts no-projects message when list is empty', async () => {
    mockStore.listProjects.mockResolvedValue([]);

    await handleResearchCommand(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('No research projects found'),
      }),
    );
  });

  it('sets active project and posts confirmation when user picks from QuickPick', async () => {
    mockStore.listProjects.mockResolvedValue([{ title: 'Beta', slug: 'beta', status: 'active', hypotheses: [] }]);
    vi.spyOn(window, 'showQuickPick').mockResolvedValue({ label: 'Beta', slug: 'beta' } as never);
    const updateFn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({ update: updateFn } as never);

    await handleResearchCommand(state as never);

    expect(updateFn).toHaveBeenCalledWith('research.activeProject', 'beta', true);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('Beta') }),
    );
  });
});
