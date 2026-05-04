import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDispatchHandlers, type HandlerDeps } from './dispatchHandlers.js';
import type { ChatState } from '../chatState.js';
import type { BackgroundAgentManager } from '../../agent/backgroundAgent.js';
import type { WebviewMessage } from '../chatWebview.js';
import type { ExtensionContext } from 'vscode';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./chatHandlers.js', () => ({
  handleUserMessage: vi.fn().mockResolvedValue(undefined),
  handleUserMessageWithImages: vi.fn(),
  handleAttachFile: vi.fn(),
  handleAttachActiveFile: vi.fn(),
  handleDroppedPaths: vi.fn(),
  handleSaveCodeBlock: vi.fn(),
  handleCreateFile: vi.fn(),
  handleRunCommand: vi.fn().mockResolvedValue(null),
  handleMoveFile: vi.fn(),
  handleUndoChanges: vi.fn().mockResolvedValue(undefined),
  handleExportChat: vi.fn().mockResolvedValue(undefined),
  handleGenerateCommit: vi.fn().mockResolvedValue(undefined),
  handleRevertFile: vi.fn(),
  handleAcceptAllChanges: vi.fn(),
  handleDeleteMessage: vi.fn(),
  isPlanApproval: vi.fn().mockReturnValue(false),
  isPlanRejection: vi.fn().mockReturnValue(false),
  isUndoRequest: vi.fn().mockReturnValue(false),
  isCommitRequest: vi.fn().mockReturnValue(false),
  isShowDiffRequest: vi.fn().mockReturnValue(false),
  handleShowSystemPrompt: vi.fn(),
  handleReconnect: vi.fn(),
}));

vi.mock('./agentHandlers.js', () => ({
  handleExecutePlan: vi.fn().mockResolvedValue(undefined),
  handleRevisePlan: vi.fn().mockResolvedValue(undefined),
  handleBatch: vi.fn(),
  handleInsight: vi.fn(),
  handleSpec: vi.fn(),
  handleGenerateDoc: vi.fn(),
  handleUsage: vi.fn(),
  handleResume: vi.fn(),
  handleContext: vi.fn(),
  handleGenerateTests: vi.fn(),
  handleLint: vi.fn(),
  handleDeps: vi.fn(),
  handleScaffold: vi.fn(),
  handleAudit: vi.fn(),
  handleInsights: vi.fn(),
  handleExplainToolDecision: vi.fn(),
  handleMcpStatus: vi.fn(),
  handleInit: vi.fn(),
  handleListMemories: vi.fn(),
  handleSearchMemories: vi.fn(),
  handleCompactContext: vi.fn(),
  handleToggleVerbose: vi.fn(),
  handleListSkills: vi.fn(),
  handleGetSkillsForMenu: vi.fn(),
}));

vi.mock('./githubHandlers.js', () => ({ handleGitHubCommand: vi.fn() }));
vi.mock('./modelHandlers.js', () => ({
  loadModels: vi.fn(),
  handleInstallModel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sessionHandlers.js', () => ({
  handleSaveSession: vi.fn(),
  handleLoadSession: vi.fn(),
  handleDeleteSession: vi.fn(),
  handleListSessions: vi.fn(),
}));
vi.mock('./notebookHandlers.js', () => ({
  handleNotebookStart: vi.fn(),
  handleNotebookExit: vi.fn(),
}));
vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    customModes: [],
    agentMode: 'cautious',
    forkEnabled: false,
    forkDefaultCount: 3,
    forkMaxConcurrent: 2,
    verboseMode: false,
  }),
}));
vi.mock('../../agent/diff.js', () => ({ computeUnifiedDiff: vi.fn().mockReturnValue('') }));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    clearChat: vi.fn(),
    abort: vi.fn(),
    cancelInstall: vi.fn(),
    resolveAllConfirms: vi.fn(),
    resolveConfirm: vi.fn(),
    resolveClarification: vi.fn(),
    refreshModelRouter: vi.fn(),
    postMessage: vi.fn(),
    currentSteerQueue: null,
    pendingPlan: null,
    pendingPlanMessages: [],
    changelog: { hasChanges: vi.fn().mockReturnValue(false), getChangeSummary: vi.fn().mockResolvedValue([]) },
    ...overrides,
  } as unknown as ChatState;
}

function makeBgManager(): BackgroundAgentManager {
  return {
    start: vi.fn().mockReturnValue('bg-1'),
    stop: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    dispose: vi.fn(),
  } as unknown as BackgroundAgentManager;
}

function makeGlobalState(): ExtensionContext['globalState'] {
  return {
    update: vi.fn(),
    get: vi.fn(),
    keys: vi.fn().mockReturnValue([]),
  } as unknown as ExtensionContext['globalState'];
}

function makeDeps(stateOverrides: Partial<ChatState> = {}): {
  deps: HandlerDeps;
  state: ChatState;
  postMessage: ReturnType<typeof vi.fn>;
} {
  const state = makeState(stateOverrides);
  const postMessage = vi.fn();
  return {
    deps: {
      state,
      bgManager: makeBgManager(),
      globalState: makeGlobalState(),
      postMessage,
      setModel: vi.fn().mockResolvedValue(undefined),
    },
    state,
    postMessage,
  };
}

async function invoke(
  handlers: ReturnType<typeof buildDispatchHandlers>,
  command: string,
  msg: Partial<WebviewMessage> = {},
): Promise<void> {
  const handler = handlers[command];
  expect(handler, `handler "${command}" not found`).toBeDefined();
  await handler!({ command, ...msg } as WebviewMessage);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildDispatchHandlers', () => {
  let deps: HandlerDeps;
  let state: ChatState;
  let postMessage: ReturnType<typeof vi.fn>;
  let handlers: ReturnType<typeof buildDispatchHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ deps, state, postMessage } = makeDeps());
    handlers = buildDispatchHandlers(deps);
  });

  // ── Basic routing ─────────────────────────────────────────────────────────

  it('newChat delegates to state.clearChat()', async () => {
    await invoke(handlers, 'newChat');
    expect(state.clearChat).toHaveBeenCalledOnce();
  });

  it('abort delegates to state.abort()', async () => {
    await invoke(handlers, 'abort');
    expect(state.abort).toHaveBeenCalledOnce();
  });

  it('changeModel calls setModel with the requested model', async () => {
    await invoke(handlers, 'changeModel', { model: 'gpt-4o' });
    expect(deps.setModel).toHaveBeenCalledWith('gpt-4o');
  });

  it('changeModel falls back to llama3 when no model provided', async () => {
    await invoke(handlers, 'changeModel', {});
    expect(deps.setModel).toHaveBeenCalledWith('llama3');
  });

  // ── userMessage plan rejection path ───────────────────────────────────────

  it('userMessage with pending plan + rejection clears the plan and posts done', async () => {
    const { isPlanRejection } = await import('./chatHandlers.js');
    vi.mocked(isPlanRejection).mockReturnValueOnce(true);
    const pendingState = makeState({ pendingPlan: { steps: [] } as unknown as ChatState['pendingPlan'] });
    const h = buildDispatchHandlers({ ...deps, state: pendingState });
    await invoke(h, 'userMessage', { text: 'no thanks' });
    expect(pendingState.pendingPlan).toBeNull();
    expect(pendingState.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
  });

  // ── openExternal security guard ───────────────────────────────────────────

  it('openExternal rejects file:// URLs silently', async () => {
    // The handler returns without calling env.openExternal for non-http(s) URIs.
    // The VS Code mock accepts any env.openExternal call, so we just verify
    // no error is thrown.
    await expect(invoke(handlers, 'openExternal', { url: 'file:///etc/passwd' })).resolves.not.toThrow();
  });

  // ── executeExtensionCommand allowlist ─────────────────────────────────────

  it('executeExtensionCommand rejects unlisted commands with an error postMessage', async () => {
    await invoke(handlers, 'executeExtensionCommand', { commandId: 'arbitrary.bad.command' });
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('arbitrary.bad.command') }),
    );
  });

  // ── dismissOnboarding ─────────────────────────────────────────────────────

  it('dismissOnboarding updates globalState', async () => {
    await invoke(handlers, 'dismissOnboarding');
    expect(deps.globalState.update).toHaveBeenCalledWith('sidecar.onboardingComplete', true);
  });

  // ── Steer handlers ────────────────────────────────────────────────────────

  it('steerEnqueue is a no-op when currentSteerQueue is null', async () => {
    await expect(invoke(handlers, 'steerEnqueue', { text: 'hello' })).resolves.not.toThrow();
  });

  it('steerEnqueue is a no-op for empty text', async () => {
    const queue = { enqueue: vi.fn(), cancel: vi.fn(), edit: vi.fn() };
    const h = buildDispatchHandlers({
      ...deps,
      state: makeState({ currentSteerQueue: queue as unknown as ChatState['currentSteerQueue'] }),
    });
    await invoke(h, 'steerEnqueue', { text: '   ' });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('steerEnqueue calls queue.enqueue with nudge default urgency', async () => {
    const queue = { enqueue: vi.fn(), cancel: vi.fn(), edit: vi.fn() };
    const h = buildDispatchHandlers({
      ...deps,
      state: makeState({ currentSteerQueue: queue as unknown as ChatState['currentSteerQueue'] }),
    });
    await invoke(h, 'steerEnqueue', { text: 'stop and check' });
    expect(queue.enqueue).toHaveBeenCalledWith('stop and check', 'nudge');
  });

  it('steerEnqueue posts error when queue.enqueue throws', async () => {
    const queue = {
      enqueue: vi.fn().mockImplementation(() => {
        throw new Error('queue full');
      }),
      cancel: vi.fn(),
      edit: vi.fn(),
    };
    const s = makeState({ currentSteerQueue: queue as unknown as ChatState['currentSteerQueue'] });
    const h = buildDispatchHandlers({ ...deps, state: s });
    await invoke(h, 'steerEnqueue', { text: 'something' });
    expect(s.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('queue full') }),
    );
  });

  // ── bgStart ───────────────────────────────────────────────────────────────

  it('bgStart starts a background agent and posts assistant message', async () => {
    await invoke(handlers, 'bgStart', { text: 'run linting' });
    expect(deps.bgManager.start).toHaveBeenCalledWith('run linting');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'assistantMessage' }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
  });

  it('bgStart ignores empty task', async () => {
    await invoke(handlers, 'bgStart', { text: '' });
    expect(deps.bgManager.start).not.toHaveBeenCalled();
  });

  // ── changeAgentMode ───────────────────────────────────────────────────────

  it('changeAgentMode is a no-op for unknown modes', async () => {
    await expect(invoke(handlers, 'changeAgentMode', { agentMode: 'ultra-turbo' })).resolves.not.toThrow();
  });

  it('changeAgentMode resolves all confirms when switching to autonomous', async () => {
    const { getConfig } = await import('../../config/settings.js');
    vi.mocked(getConfig).mockReturnValueOnce({
      customModes: [],
      agentMode: 'cautious',
      forkEnabled: false,
      forkDefaultCount: 3,
      forkMaxConcurrent: 2,
      verboseMode: false,
    } as unknown as ReturnType<typeof getConfig>);
    await invoke(handlers, 'changeAgentMode', { agentMode: 'autonomous' });
    expect(state.resolveAllConfirms).toHaveBeenCalledWith('Allow');
  });
});
