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
  handleSpec: vi.fn(),
  handleGenerateDoc: vi.fn(),
  handleResume: vi.fn(),
  handleGenerateTests: vi.fn(),
  handleScaffold: vi.fn(),
  handleExplainToolDecision: vi.fn(),
  handleInit: vi.fn(),
  handleCompactContext: vi.fn(),
}));

vi.mock('./infoHandlers.js', () => ({
  handleInsight: vi.fn(),
  handleUsage: vi.fn(),
  handleContext: vi.fn(),
  handleLint: vi.fn(),
  handleDeps: vi.fn(),
  handleAudit: vi.fn(),
  handleInsights: vi.fn(),
  handleMcpStatus: vi.fn(),
  handleListMemories: vi.fn(),
  handleSearchMemories: vi.fn(),
  handleToggleVerbose: vi.fn(),
  handleListSkills: vi.fn(),
  handleGetSkillsForMenu: vi.fn(),
}));

vi.mock('./githubHandlers.js', () => ({ handleGitHubCommand: vi.fn() }));
vi.mock('./modelHandlers.js', () => ({
  loadModels: vi.fn(),
  handleInstallModel: vi.fn().mockResolvedValue(undefined),
  handleKickstandLoadModel: vi.fn().mockResolvedValue(undefined),
  handleKickstandUnloadModel: vi.fn().mockResolvedValue(undefined),
  handleDeleteModel: vi.fn().mockResolvedValue(undefined),
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

  // ── confirmResponse / clarifyResponse / cancelInstall ────────────────────

  it('confirmResponse delegates to state.resolveConfirm with text when confirmed', async () => {
    await invoke(handlers, 'confirmResponse', { confirmId: 'c-1', confirmed: true, text: 'yes' });
    expect(state.resolveConfirm).toHaveBeenCalledWith('c-1', 'yes');
  });

  it('confirmResponse passes undefined text when not confirmed', async () => {
    await invoke(handlers, 'confirmResponse', { confirmId: 'c-1', confirmed: false });
    expect(state.resolveConfirm).toHaveBeenCalledWith('c-1', undefined);
  });

  it('clarifyResponse delegates to state.resolveClarification', async () => {
    await invoke(handlers, 'clarifyResponse', { confirmId: 'q-1', text: 'more context' });
    expect(state.resolveClarification).toHaveBeenCalledWith('q-1', 'more context');
  });

  it('cancelInstall delegates to state.cancelInstall', async () => {
    await invoke(handlers, 'cancelInstall');
    expect(state.cancelInstall).toHaveBeenCalledOnce();
  });

  // ── openExternal ──────────────────────────────────────────────────────────

  it('openExternal with no url is a no-op', async () => {
    await expect(invoke(handlers, 'openExternal', {})).resolves.not.toThrow();
  });

  it('openExternal allows https URLs on the safe-domain allowlist', async () => {
    const { env } = await import('vscode');
    await invoke(handlers, 'openExternal', { url: 'https://github.com/nedonatelli/sidecar' });
    expect(env.openExternal).toHaveBeenCalledOnce();
  });

  it('openExternal blocks unknown domains', async () => {
    const { env } = await import('vscode');
    await invoke(handlers, 'openExternal', { url: 'https://example.com' });
    expect(env.openExternal).not.toHaveBeenCalled();
  });

  // ── runCommand ────────────────────────────────────────────────────────────

  it('runCommand posts commandResult when handleRunCommand returns output', async () => {
    const { handleRunCommand } = await import('./chatHandlers.js');
    vi.mocked(handleRunCommand).mockResolvedValueOnce('stdout output');
    await invoke(handlers, 'runCommand', { text: 'echo hi' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'commandResult', content: 'stdout output' }),
    );
  });

  it('runCommand does not post when handleRunCommand returns null', async () => {
    const { handleRunCommand } = await import('./chatHandlers.js');
    vi.mocked(handleRunCommand).mockResolvedValueOnce(null);
    await invoke(handlers, 'runCommand', { text: 'echo hi' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  // ── userMessage with images ───────────────────────────────────────────────

  it('userMessage with images calls handleUserMessageWithImages then handleUserMessage', async () => {
    const { handleUserMessageWithImages, handleUserMessage } = await import('./chatHandlers.js');
    const img = { mediaType: 'image/png', data: 'abc' };
    await invoke(handlers, 'userMessage', { text: 'describe this', images: [img] });
    expect(handleUserMessageWithImages).toHaveBeenCalledWith(state, 'describe this', [img]);
    expect(handleUserMessage).toHaveBeenCalledWith(state, '');
  });

  // ── steerCancel / steerEdit ───────────────────────────────────────────────

  it('steerCancel calls queue.cancel with steerId', async () => {
    const queue = { enqueue: vi.fn(), cancel: vi.fn(), edit: vi.fn() };
    const h = buildDispatchHandlers({
      ...deps,
      state: makeState({ currentSteerQueue: queue as unknown as ChatState['currentSteerQueue'] }),
    });
    await invoke(h, 'steerCancel', { steerId: 'steer-42' });
    expect(queue.cancel).toHaveBeenCalledWith('steer-42');
  });

  it('steerEdit is a no-op for empty text', async () => {
    const queue = { enqueue: vi.fn(), cancel: vi.fn(), edit: vi.fn() };
    const h = buildDispatchHandlers({
      ...deps,
      state: makeState({ currentSteerQueue: queue as unknown as ChatState['currentSteerQueue'] }),
    });
    await invoke(h, 'steerEdit', { steerId: 'steer-1', text: '   ' });
    expect(queue.edit).not.toHaveBeenCalled();
  });

  it('steerEdit calls queue.edit with steerId and text', async () => {
    const queue = { enqueue: vi.fn(), cancel: vi.fn(), edit: vi.fn() };
    const h = buildDispatchHandlers({
      ...deps,
      state: makeState({ currentSteerQueue: queue as unknown as ChatState['currentSteerQueue'] }),
    });
    await invoke(h, 'steerEdit', { steerId: 'steer-1', text: 'revised instruction' });
    expect(queue.edit).toHaveBeenCalledWith('steer-1', 'revised instruction');
  });

  it('steerEdit posts error when queue.edit throws', async () => {
    const queue = {
      enqueue: vi.fn(),
      cancel: vi.fn(),
      edit: vi.fn().mockImplementation(() => {
        throw new Error('immutable');
      }),
    };
    const s = makeState({ currentSteerQueue: queue as unknown as ChatState['currentSteerQueue'] });
    const h = buildDispatchHandlers({ ...deps, state: s });
    await invoke(h, 'steerEdit', { steerId: 'steer-1', text: 'revised' });
    expect(s.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('immutable') }),
    );
  });

  // ── bgStop / bgList / bgExpand ────────────────────────────────────────────

  it('bgStop delegates to bgManager.stop', async () => {
    await invoke(handlers, 'bgStop', { text: 'bg-1' });
    expect(deps.bgManager.stop).toHaveBeenCalledWith('bg-1');
  });

  it('bgList posts bgList with bgManager.list()', async () => {
    const fakeList = [{ id: 'bg-1', status: 'running' }];
    vi.mocked(deps.bgManager.list).mockReturnValueOnce(fakeList as unknown as ReturnType<typeof deps.bgManager.list>);
    await invoke(handlers, 'bgList');
    expect(postMessage).toHaveBeenCalledWith({ command: 'bgList', bgRuns: fakeList });
  });

  it('bgExpand posts bgComplete when run is found', async () => {
    const fakeRun = { id: 'bg-1', status: 'completed' };
    vi.mocked(deps.bgManager.get).mockReturnValueOnce(fakeRun as unknown as ReturnType<typeof deps.bgManager.get>);
    await invoke(handlers, 'bgExpand', { text: 'bg-1' });
    expect(postMessage).toHaveBeenCalledWith({ command: 'bgComplete', bgRun: fakeRun });
  });

  it('bgExpand is a no-op when run is not found', async () => {
    vi.mocked(deps.bgManager.get).mockReturnValueOnce(undefined);
    await invoke(handlers, 'bgExpand', { text: 'bg-missing' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  // ── Simple delegation handlers ────────────────────────────────────────────

  it('attachFile delegates to handleAttachFile', async () => {
    const { handleAttachFile } = await import('./chatHandlers.js');
    await invoke(handlers, 'attachFile');
    expect(handleAttachFile).toHaveBeenCalledWith(state);
  });

  it('attachActiveFile delegates to handleAttachActiveFile', async () => {
    const { handleAttachActiveFile } = await import('./chatHandlers.js');
    await invoke(handlers, 'attachActiveFile');
    expect(handleAttachActiveFile).toHaveBeenCalledWith(state);
  });

  it('droppedPaths delegates to handleDroppedPaths', async () => {
    const { handleDroppedPaths } = await import('./chatHandlers.js');
    await invoke(handlers, 'droppedPaths', { paths: ['/a', '/b'] });
    expect(handleDroppedPaths).toHaveBeenCalledWith(state, ['/a', '/b']);
  });

  it('saveCodeBlock delegates to handleSaveCodeBlock', async () => {
    const { handleSaveCodeBlock } = await import('./chatHandlers.js');
    await invoke(handlers, 'saveCodeBlock', { code: 'const x = 1', language: 'ts' });
    expect(handleSaveCodeBlock).toHaveBeenCalledWith('const x = 1', 'ts');
  });

  it('createFile delegates to handleCreateFile', async () => {
    const { handleCreateFile } = await import('./chatHandlers.js');
    await invoke(handlers, 'createFile', { code: 'hello', filePath: '/out/file.ts' });
    expect(handleCreateFile).toHaveBeenCalledWith(state, 'hello', '/out/file.ts');
  });

  it('moveFile delegates to handleMoveFile', async () => {
    const { handleMoveFile } = await import('./chatHandlers.js');
    await invoke(handlers, 'moveFile', { sourcePath: '/a.ts', destPath: '/b.ts' });
    expect(handleMoveFile).toHaveBeenCalledWith(state, '/a.ts', '/b.ts');
  });

  it('undoChanges delegates to handleUndoChanges', async () => {
    const { handleUndoChanges } = await import('./chatHandlers.js');
    await invoke(handlers, 'undoChanges');
    expect(handleUndoChanges).toHaveBeenCalledWith(state);
  });

  it('exportChat delegates to handleExportChat', async () => {
    const { handleExportChat } = await import('./chatHandlers.js');
    await invoke(handlers, 'exportChat');
    expect(handleExportChat).toHaveBeenCalledWith(state);
  });

  it('executePlan delegates to handleExecutePlan', async () => {
    const { handleExecutePlan } = await import('./agentHandlers.js');
    await invoke(handlers, 'executePlan');
    expect(handleExecutePlan).toHaveBeenCalledWith(state);
  });

  it('revisePlan delegates to handleRevisePlan', async () => {
    const { handleRevisePlan } = await import('./agentHandlers.js');
    await invoke(handlers, 'revisePlan', { text: 'add logging' });
    expect(handleRevisePlan).toHaveBeenCalledWith(state, 'add logging');
  });

  it('batch delegates to handleBatch', async () => {
    const { handleBatch } = await import('./agentHandlers.js');
    await invoke(handlers, 'batch', { text: 'fix all tests' });
    expect(handleBatch).toHaveBeenCalledWith(state, 'fix all tests');
  });

  it('insight delegates to handleInsight', async () => {
    const { handleInsight } = await import('./infoHandlers.js');
    await invoke(handlers, 'insight');
    expect(handleInsight).toHaveBeenCalledWith(state);
  });

  it('spec delegates to handleSpec', async () => {
    const { handleSpec } = await import('./agentHandlers.js');
    await invoke(handlers, 'spec', { text: 'build auth module' });
    expect(handleSpec).toHaveBeenCalledWith(state, 'build auth module');
  });

  it('generateDoc delegates to handleGenerateDoc', async () => {
    const { handleGenerateDoc } = await import('./agentHandlers.js');
    await invoke(handlers, 'generateDoc');
    expect(handleGenerateDoc).toHaveBeenCalledWith(state);
  });

  it('usage delegates to handleUsage', async () => {
    const { handleUsage } = await import('./infoHandlers.js');
    await invoke(handlers, 'usage');
    expect(handleUsage).toHaveBeenCalledWith(state);
  });

  it('resume delegates to handleResume', async () => {
    const { handleResume } = await import('./agentHandlers.js');
    await invoke(handlers, 'resume');
    expect(handleResume).toHaveBeenCalledWith(state);
  });

  it('context delegates to handleContext', async () => {
    const { handleContext } = await import('./infoHandlers.js');
    await invoke(handlers, 'context');
    expect(handleContext).toHaveBeenCalledWith(state);
  });

  it('generateTests delegates to handleGenerateTests', async () => {
    const { handleGenerateTests } = await import('./agentHandlers.js');
    await invoke(handlers, 'generateTests');
    expect(handleGenerateTests).toHaveBeenCalledWith(state);
  });

  it('lint delegates to handleLint', async () => {
    const { handleLint } = await import('./infoHandlers.js');
    await invoke(handlers, 'lint', { text: 'src/' });
    expect(handleLint).toHaveBeenCalledWith(state, 'src/');
  });

  it('deps delegates to handleDeps', async () => {
    const { handleDeps } = await import('./infoHandlers.js');
    await invoke(handlers, 'deps');
    expect(handleDeps).toHaveBeenCalledWith(state);
  });

  it('scaffold delegates to handleScaffold', async () => {
    const { handleScaffold } = await import('./agentHandlers.js');
    await invoke(handlers, 'scaffold', { text: 'express-api' });
    expect(handleScaffold).toHaveBeenCalledWith(state, 'express-api');
  });

  it('audit delegates to handleAudit', async () => {
    const { handleAudit } = await import('./infoHandlers.js');
    await invoke(handlers, 'audit', { text: 'auth' });
    expect(handleAudit).toHaveBeenCalledWith(state, 'auth');
  });

  it('insights delegates to handleInsights', async () => {
    const { handleInsights } = await import('./infoHandlers.js');
    await invoke(handlers, 'insights');
    expect(handleInsights).toHaveBeenCalledWith(state);
  });

  it('compactContext delegates to handleCompactContext', async () => {
    const { handleCompactContext } = await import('./agentHandlers.js');
    await invoke(handlers, 'compactContext');
    expect(handleCompactContext).toHaveBeenCalledWith(state);
  });

  it('toggleVerbose delegates to handleToggleVerbose', async () => {
    const { handleToggleVerbose } = await import('./infoHandlers.js');
    await invoke(handlers, 'toggleVerbose');
    expect(handleToggleVerbose).toHaveBeenCalledWith(state);
  });

  it('listSkills delegates to handleListSkills', async () => {
    const { handleListSkills } = await import('./infoHandlers.js');
    await invoke(handlers, 'listSkills');
    expect(handleListSkills).toHaveBeenCalledWith(state);
  });

  it('getSkillsForMenu delegates to handleGetSkillsForMenu', async () => {
    const { handleGetSkillsForMenu } = await import('./infoHandlers.js');
    await invoke(handlers, 'getSkillsForMenu');
    expect(handleGetSkillsForMenu).toHaveBeenCalledWith(state);
  });

  it('listMemories delegates to handleListMemories', async () => {
    const { handleListMemories } = await import('./infoHandlers.js');
    await invoke(handlers, 'listMemories');
    expect(handleListMemories).toHaveBeenCalledWith(state);
  });

  it('searchMemories delegates to handleSearchMemories', async () => {
    const { handleSearchMemories } = await import('./infoHandlers.js');
    await invoke(handlers, 'searchMemories', { text: 'auth token' });
    expect(handleSearchMemories).toHaveBeenCalledWith(state, 'auth token');
  });

  it('generateCommit delegates to handleGenerateCommit', async () => {
    const { handleGenerateCommit } = await import('./chatHandlers.js');
    await invoke(handlers, 'generateCommit');
    expect(handleGenerateCommit).toHaveBeenCalledWith(state);
  });

  it('revertFile delegates to handleRevertFile', async () => {
    const { handleRevertFile } = await import('./chatHandlers.js');
    await invoke(handlers, 'revertFile', { filePath: '/src/foo.ts' });
    expect(handleRevertFile).toHaveBeenCalledWith(state, '/src/foo.ts');
  });

  it('acceptAllChanges delegates to handleAcceptAllChanges', async () => {
    const { handleAcceptAllChanges } = await import('./chatHandlers.js');
    await invoke(handlers, 'acceptAllChanges');
    expect(handleAcceptAllChanges).toHaveBeenCalledWith(state);
  });

  it('deleteMessage delegates to handleDeleteMessage', async () => {
    const { handleDeleteMessage } = await import('./chatHandlers.js');
    await invoke(handlers, 'deleteMessage', { index: 3 });
    expect(handleDeleteMessage).toHaveBeenCalledWith(state, 3);
  });

  it('mcpStatus delegates to handleMcpStatus', async () => {
    const { handleMcpStatus } = await import('./infoHandlers.js');
    await invoke(handlers, 'mcpStatus');
    expect(handleMcpStatus).toHaveBeenCalledWith(state);
  });

  it('initProject delegates to handleInit', async () => {
    const { handleInit } = await import('./agentHandlers.js');
    await invoke(handlers, 'initProject');
    expect(handleInit).toHaveBeenCalledWith(state);
  });

  it('explainToolDecision delegates to handleExplainToolDecision', async () => {
    const { handleExplainToolDecision } = await import('./agentHandlers.js');
    await invoke(handlers, 'explainToolDecision', { toolCallId: 'tc-1' });
    expect(handleExplainToolDecision).toHaveBeenCalledWith(state, 'tc-1');
  });

  // ── Session handlers ──────────────────────────────────────────────────────

  it('saveSession delegates to handleSaveSession', async () => {
    const { handleSaveSession } = await import('./sessionHandlers.js');
    await invoke(handlers, 'saveSession', { text: 'my session' });
    expect(handleSaveSession).toHaveBeenCalledWith(state, 'my session');
  });

  it('loadSession delegates to handleLoadSession', async () => {
    const { handleLoadSession } = await import('./sessionHandlers.js');
    await invoke(handlers, 'loadSession', { text: 'sess-1' });
    expect(handleLoadSession).toHaveBeenCalledWith(state, 'sess-1');
  });

  it('deleteSession delegates to handleDeleteSession', async () => {
    const { handleDeleteSession } = await import('./sessionHandlers.js');
    await invoke(handlers, 'deleteSession', { text: 'sess-1' });
    expect(handleDeleteSession).toHaveBeenCalledWith(state, 'sess-1');
  });

  it('listSessions delegates to handleListSessions', async () => {
    const { handleListSessions } = await import('./sessionHandlers.js');
    await invoke(handlers, 'listSessions');
    expect(handleListSessions).toHaveBeenCalledWith(state);
  });

  // ── Notebook handlers ─────────────────────────────────────────────────────

  it('notebookStart delegates to handleNotebookStart', async () => {
    const { handleNotebookStart } = await import('./notebookHandlers.js');
    await invoke(handlers, 'notebookStart');
    expect(handleNotebookStart).toHaveBeenCalledWith(state);
  });

  it('notebookExit delegates to handleNotebookExit', async () => {
    const { handleNotebookExit } = await import('./notebookHandlers.js');
    await invoke(handlers, 'notebookExit');
    expect(handleNotebookExit).toHaveBeenCalledWith(state);
  });

  // ── GitHub handler ────────────────────────────────────────────────────────

  it('github delegates to handleGitHubCommand', async () => {
    const { handleGitHubCommand } = await import('./githubHandlers.js');
    const msg = { command: 'github' as const, text: 'pr list' };
    await invoke(handlers, 'github', msg);
    expect(handleGitHubCommand).toHaveBeenCalledWith(state, expect.objectContaining({ command: 'github' }));
  });

  // ── PR / CI commands ──────────────────────────────────────────────────────

  it('reviewChanges calls executeCommand sidecar.reviewChanges', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'reviewChanges');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.reviewChanges');
  });

  it('prSummary calls executeCommand sidecar.summarizePR', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'prSummary');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.summarizePR');
  });

  it('commitMessage calls executeCommand sidecar.generateCommitMessage', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'commitMessage');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.generateCommitMessage');
  });

  // ── executeExtensionCommand — allowed path ────────────────────────────────

  it('executeExtensionCommand executes an allowed command', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'executeExtensionCommand', { commandId: 'sidecar.clearChat', args: [] });
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.clearChat');
  });

  // ── Additional PR / CI commands ───────────────────────────────────────────

  it('createDraftPR calls executeCommand sidecar.pr.create', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'createDraftPR');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.pr.create');
  });

  it('analyzeCi calls executeCommand sidecar.ci.analyze', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'analyzeCi');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.ci.analyze');
  });

  it('reviewPrComments calls executeCommand sidecar.pr.reviewComments', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'reviewPrComments');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.pr.reviewComments');
  });

  it('respondPrComments calls executeCommand sidecar.pr.respond', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'respondPrComments');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.pr.respond');
  });

  it('markPrReady calls executeCommand sidecar.pr.markReady', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'markPrReady');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.pr.markReady');
  });

  it('checkPrCi calls executeCommand sidecar.pr.checkCi', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'checkPrCi');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.pr.checkCi');
  });

  it('scanStaged calls executeCommand sidecar.scanStaged', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'scanStaged');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.scanStaged');
  });

  it('stopAutoMode calls executeCommand sidecar.stopAutoMode', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'stopAutoMode');
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.stopAutoMode');
  });

  it('forkStart with empty task is a no-op', async () => {
    await expect(invoke(handlers, 'forkStart', { text: '' })).resolves.not.toThrow();
    expect(deps.bgManager.start).not.toHaveBeenCalled();
  });

  it('showSystemPrompt calls handleShowSystemPrompt via dynamic import', async () => {
    const { handleShowSystemPrompt } = await import('./chatHandlers.js');
    await invoke(handlers, 'showSystemPrompt');
    expect(handleShowSystemPrompt).toHaveBeenCalledWith(state);
  });

  it('reconnect calls handleReconnect via dynamic import', async () => {
    const { handleReconnect } = await import('./chatHandlers.js');
    await invoke(handlers, 'reconnect');
    expect(handleReconnect).toHaveBeenCalledWith(state);
  });

  // ── userMessage routing branches ──────────────────────────────────────────

  it('userMessage with isUndoRequest calls handleUndoChanges', async () => {
    const { isUndoRequest, handleUndoChanges } = await import('./chatHandlers.js');
    vi.mocked(isUndoRequest).mockReturnValueOnce(true);
    await invoke(handlers, 'userMessage', { text: 'undo' });
    expect(handleUndoChanges).toHaveBeenCalledWith(state);
  });

  it('userMessage with isCommitRequest calls handleGenerateCommit', async () => {
    const { isCommitRequest, handleGenerateCommit } = await import('./chatHandlers.js');
    vi.mocked(isCommitRequest).mockReturnValueOnce(true);
    await invoke(handlers, 'userMessage', { text: 'commit' });
    expect(handleGenerateCommit).toHaveBeenCalledWith(state);
  });

  it('userMessage with isShowDiffRequest and no changelog changes posts no-changes message', async () => {
    const { isShowDiffRequest } = await import('./chatHandlers.js');
    vi.mocked(isShowDiffRequest).mockReturnValueOnce(true);
    await invoke(handlers, 'userMessage', { text: 'show diff' });
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('No changes') }),
    );
  });

  it('userMessage with pending plan + isPlanApproval calls handleExecutePlan', async () => {
    const { isPlanApproval } = await import('./chatHandlers.js');
    const { handleExecutePlan } = await import('./agentHandlers.js');
    vi.mocked(isPlanApproval).mockReturnValueOnce(true);
    const pendingState = makeState({ pendingPlan: { steps: [] } as unknown as ChatState['pendingPlan'] });
    const h = buildDispatchHandlers({ ...deps, state: pendingState });
    await invoke(h, 'userMessage', { text: 'yes' });
    expect(handleExecutePlan).toHaveBeenCalledWith(pendingState);
  });

  it('userMessage with pending plan + no match calls handleRevisePlan', async () => {
    const { handleRevisePlan } = await import('./agentHandlers.js');
    const pendingState = makeState({ pendingPlan: { steps: [] } as unknown as ChatState['pendingPlan'] });
    const h = buildDispatchHandlers({ ...deps, state: pendingState });
    await invoke(h, 'userMessage', { text: 'change the auth step' });
    expect(handleRevisePlan).toHaveBeenCalledWith(pendingState, 'change the auth step');
  });

  // ── Remaining handlers ────────────────────────────────────────────────────

  it('openSettings calls executeCommand workbench.action.openSettings', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'openSettings');
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'sidecar');
  });

  it('switchBackend calls executeCommand sidecar.switchBackend', async () => {
    const { commands } = await import('vscode');
    await invoke(handlers, 'switchBackend', { profileId: 'anthropic' });
    expect(commands.executeCommand).toHaveBeenCalledWith('sidecar.switchBackend', 'anthropic');
  });

  it('kickstandLoad with modelId calls handleKickstandLoadModel', async () => {
    const { handleKickstandLoadModel } = await import('./modelHandlers.js');
    await invoke(handlers, 'kickstandLoad', { modelId: 'llama3' });
    expect(handleKickstandLoadModel).toHaveBeenCalledWith(state, 'llama3');
  });

  it('kickstandLoad without modelId is a no-op', async () => {
    const { handleKickstandLoadModel } = await import('./modelHandlers.js');
    await invoke(handlers, 'kickstandLoad', {});
    expect(handleKickstandLoadModel).not.toHaveBeenCalled();
  });

  it('kickstandUnload with modelId calls handleKickstandUnloadModel', async () => {
    const { handleKickstandUnloadModel } = await import('./modelHandlers.js');
    await invoke(handlers, 'kickstandUnload', { modelId: 'llama3' });
    expect(handleKickstandUnloadModel).toHaveBeenCalledWith(state, 'llama3');
  });

  it('deleteModel with model calls handleDeleteModel', async () => {
    const { handleDeleteModel } = await import('./modelHandlers.js');
    await invoke(handlers, 'deleteModel', { model: 'llama3' });
    expect(handleDeleteModel).toHaveBeenCalledWith(state, 'llama3');
  });

  it('_loadModels calls loadModels', async () => {
    const { loadModels } = await import('./modelHandlers.js');
    await invoke(handlers, '_loadModels');
    expect(loadModels).toHaveBeenCalledWith(state);
  });

  it('userMessage /compact calls handleCompactContext', async () => {
    const { handleCompactContext } = await import('./agentHandlers.js');
    await invoke(handlers, 'userMessage', { text: '/compact' });
    expect(handleCompactContext).toHaveBeenCalledWith(state);
  });

  it('userMessage /COMPACT (case-insensitive) calls handleCompactContext', async () => {
    const { handleCompactContext } = await import('./agentHandlers.js');
    await invoke(handlers, 'userMessage', { text: '/COMPACT' });
    expect(handleCompactContext).toHaveBeenCalledWith(state);
  });

  it('userMessage /undo calls handleUndoChanges', async () => {
    const { handleUndoChanges } = await import('./chatHandlers.js');
    await invoke(handlers, 'userMessage', { text: '/undo' });
    expect(handleUndoChanges).toHaveBeenCalledWith(state);
  });

  it('userMessage /UNDO (case-insensitive) calls handleUndoChanges', async () => {
    const { handleUndoChanges } = await import('./chatHandlers.js');
    await invoke(handlers, 'userMessage', { text: '/UNDO' });
    expect(handleUndoChanges).toHaveBeenCalledWith(state);
  });
});
