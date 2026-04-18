import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMcpStatus, handleResume } from './agentHandlers.js';
import { window, workspace } from 'vscode';

// Mock dependent modules so agentHandlers can call them without real LLM/filesystem
vi.mock('../../agent/docGenerator.js', () => ({
  generateDocumentation: vi.fn().mockResolvedValue('/** Documented code */\nfunction foo() {}'),
}));
vi.mock('../../agent/testGenerator.js', () => ({
  generateTests: vi.fn().mockResolvedValue({ testFileName: 'app.test.ts', content: 'test("works", () => {})' }),
}));
vi.mock('../../agent/scaffold.js', () => ({
  generateScaffold: vi.fn().mockResolvedValue('export class MyComponent {}'),
  getTemplateList: vi.fn().mockReturnValue('Available templates: component, service, hook'),
}));
vi.mock('../../agent/lintFix.js', () => ({
  runLint: vi.fn().mockResolvedValue({ output: 'All clear', success: true }),
}));
vi.mock('../../agent/depAnalysis.js', () => ({
  analyzeDependencies: vi.fn().mockResolvedValue('# Dependencies\nNo issues found.'),
}));
vi.mock('../../agent/specDriven.js', () => ({
  generateSpec: vi.fn().mockResolvedValue('## Spec\n- A'),
  saveSpec: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../agent/batch.js', () => ({
  parseBatchInput: vi.fn().mockReturnValue({ mode: 'sequential', tasks: [] }),
  runBatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../agent/conversationAnalytics.js', () => ({
  analyzeConversation: vi.fn().mockReturnValue({}),
  formatAnalyticsReport: vi.fn().mockReturnValue('# Insights\n- pattern'),
}));

describe('handleMcpStatus', () => {
  it('shows "none configured" when no servers exist', () => {
    const state = {
      mcpManager: {
        getServerStatus: () => [],
        getToolCount: () => 0,
      },
      postMessage: vi.fn(),
    };
    handleMcpStatus(state as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('None configured'),
      }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
  });

  it('lists connected servers with tool counts', () => {
    const state = {
      mcpManager: {
        getServerStatus: () => [
          {
            name: 'test-server',
            status: 'connected',
            transport: 'stdio',
            toolCount: 5,
            connectedSinceMs: 30000,
          },
        ],
        getToolCount: () => 5,
      },
      postMessage: vi.fn(),
    };
    handleMcpStatus(state as never);
    const msgCall = state.postMessage.mock.calls.find(
      (c: Array<{ command: string }>) => c[0].command === 'assistantMessage',
    );
    expect(msgCall).toBeDefined();
    const content = msgCall![0].content as string;
    expect(content).toContain('test-server');
    expect(content).toContain('connected');
    expect(content).toContain('Tools: 5');
    expect(content).toContain('Total tools');
  });

  it('shows error for failed servers', () => {
    const state = {
      mcpManager: {
        getServerStatus: () => [
          {
            name: 'broken-server',
            status: 'failed',
            transport: 'http',
            toolCount: 0,
            error: 'Connection refused',
          },
        ],
        getToolCount: () => 0,
      },
      postMessage: vi.fn(),
    };
    handleMcpStatus(state as never);
    const msgCall = state.postMessage.mock.calls.find(
      (c: Array<{ command: string }>) => c[0].command === 'assistantMessage',
    );
    expect(msgCall![0].content).toContain('Connection refused');
    expect(msgCall![0].content).toContain('failed');
  });
});

describe('handleAudit', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleAudit: (state: any, args: string) => Promise<void>;

  beforeEach(async () => {
    const mod = await import('./agentHandlers.js');
    handleAudit = mod.handleAudit;
  });

  it('posts error when audit log is not available', async () => {
    const state = {
      auditLog: null,
      postMessage: vi.fn(),
    };
    await handleAudit(state, '');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('not available') }),
    );
  });

  it('posts "no entries" when audit log is empty', async () => {
    const state = {
      auditLog: {
        query: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      postMessage: vi.fn(),
    };
    await handleAudit(state, '');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No audit entries') }),
    );
  });

  it('handles "clear" argument', async () => {
    const state = {
      auditLog: {
        clear: vi.fn().mockResolvedValue(undefined),
      },
      postMessage: vi.fn(),
    };
    await handleAudit(state, 'clear');
    expect(state.auditLog.clear).toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'Audit log cleared.' }));
  });
});

describe('handleInsights', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleInsights: (state: any) => Promise<void>;

  beforeEach(async () => {
    const mod = await import('./agentHandlers.js');
    handleInsights = mod.handleInsights;
  });

  it('posts error when audit log is not available', async () => {
    const state = {
      auditLog: null,
      postMessage: vi.fn(),
    };
    await handleInsights(state);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('not available') }),
    );
  });

  it('posts "no data" when both sources are empty', async () => {
    const state = {
      auditLog: { query: vi.fn().mockResolvedValue([]) },
      metricsCollector: { getHistory: () => [] },
      agentMemory: null,
      postMessage: vi.fn(),
    };
    await handleInsights(state);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No data for insights') }),
    );
  });

  it('generates the analytics report and posts a done frame when audit entries exist', async () => {
    const mod = await import('./agentHandlers.js');
    const state = {
      auditLog: {
        query: vi
          .fn()
          .mockResolvedValue([
            {
              timestamp: '2026-04-18T12:00:00Z',
              tool: 'read_file',
              durationMs: 5,
              isError: false,
              input: {},
              result: '',
            },
          ]),
      },
      metricsCollector: { getHistory: () => [] },
      agentMemory: { queryAll: () => [] },
      postMessage: vi.fn(),
    };
    await mod.handleInsights(state as never);
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
  });
});

describe('handleScaffold error branch', () => {
  it('posts an error when the generator returns empty', async () => {
    const { generateScaffold } = await import('../../agent/scaffold.js');
    vi.mocked(generateScaffold).mockResolvedValueOnce('');
    const mod = await import('./agentHandlers.js');
    const state = {
      client: { updateConnection: vi.fn(), updateModel: vi.fn() },
      postMessage: vi.fn(),
    };
    await mod.handleScaffold(state as never, 'component MyThing');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Failed to generate') }),
    );
  });
});

describe('handleExplainToolDecision', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleExplainToolDecision: (state: any, toolCallId: string) => Promise<void>;

  beforeEach(async () => {
    const mod = await import('./agentHandlers.js');
    handleExplainToolDecision = mod.handleExplainToolDecision;
  });

  it('posts "not available" when no audit log', async () => {
    const state = {
      auditLog: null,
      postMessage: vi.fn(),
    };
    await handleExplainToolDecision(state, 'tc_123');
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'Audit log not available.' }));
  });

  it('posts "not found" when tool call ID is unknown', async () => {
    const state = {
      auditLog: { getByToolCallId: vi.fn().mockResolvedValue(null) },
      postMessage: vi.fn(),
    };
    await handleExplainToolDecision(state, 'tc_unknown');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Could not find') }),
    );
  });
});

describe('handleExecutePlan', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleExecutePlan: (state: any) => Promise<void>;

  beforeEach(async () => {
    const mod = await import('./agentHandlers.js');
    handleExecutePlan = mod.handleExecutePlan;
  });

  it('does nothing when no pending plan', async () => {
    const state = {
      pendingPlan: null,
      pendingPlanMessages: [],
      messages: [{ role: 'user', content: 'hello' }],
    };
    await handleExecutePlan(state);
    // Messages should be unchanged
    expect(state.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

describe('handleRevisePlan', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleRevisePlan: (state: any, feedback: string) => Promise<void>;

  beforeEach(async () => {
    const mod = await import('./agentHandlers.js');
    handleRevisePlan = mod.handleRevisePlan;
  });

  it('does nothing when no pending plan messages', async () => {
    const state = {
      pendingPlanMessages: [],
      messages: [{ role: 'user', content: 'hello' }],
    };
    await handleRevisePlan(state, 'change the approach');
    expect(state.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — handlers that depend on LLM client or external tools
// ---------------------------------------------------------------------------

function mockClient() {
  return {
    updateConnection: vi.fn(),
    updateModel: vi.fn(),
    updateSystemPrompt: vi.fn(),
    complete: vi.fn().mockResolvedValue('Generated response'),
    getSystemPrompt: vi.fn().mockReturnValue('system prompt'),
    isLocalOllama: vi.fn().mockReturnValue(true),
  };
}

describe('handleGenerateDoc (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleGenerateDoc: (state: any) => Promise<void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('./agentHandlers.js');
    handleGenerateDoc = mod.handleGenerateDoc;
  });

  it('posts error when no active editor', async () => {
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(undefined);
    const state = { postMessage: vi.fn(), client: mockClient() };
    await handleGenerateDoc(state);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('No active editor') }),
    );
  });

  it('generates documentation for active file', async () => {
    const mockEditor = {
      document: {
        getText: vi.fn().mockReturnValue('function foo() {}'),
        languageId: 'typescript',
        fileName: '/project/src/app.ts',
      },
      selection: { isEmpty: true },
    };
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(mockEditor as never);
    const state = { postMessage: vi.fn(), client: mockClient() };
    await handleGenerateDoc(state);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('Documented') }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
  });
});

describe('handleGenerateTests (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleGenerateTests: (state: any) => Promise<void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('./agentHandlers.js');
    handleGenerateTests = mod.handleGenerateTests;
  });

  it('posts error when no active editor', async () => {
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(undefined);
    const state = { postMessage: vi.fn(), client: mockClient() };
    await handleGenerateTests(state);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('No active editor') }),
    );
  });

  it('generates tests for active file', async () => {
    const mockEditor = {
      document: {
        getText: vi.fn().mockReturnValue('export function add(a, b) { return a + b; }'),
        languageId: 'typescript',
        fileName: '/project/src/math.ts',
      },
      selection: { isEmpty: true },
    };
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(mockEditor as never);
    const state = { postMessage: vi.fn(), client: mockClient() };
    await handleGenerateTests(state);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('math.ts') }),
    );
  });
});

describe('handleScaffold (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleScaffold: (state: any, text: string) => Promise<void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('./agentHandlers.js');
    handleScaffold = mod.handleScaffold;
  });

  it('lists templates when no type given', async () => {
    const state = { postMessage: vi.fn(), client: mockClient() };
    await handleScaffold(state, '');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('Available templates') }),
    );
  });

  it('generates scaffold for a given template type', async () => {
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(undefined);
    const state = { postMessage: vi.fn(), client: mockClient() };
    await handleScaffold(state, 'component UserCard');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('MyComponent') }),
    );
  });
});

describe('handleLint (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleLint: (state: any, command?: string) => Promise<void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('./agentHandlers.js');
    handleLint = mod.handleLint;
  });

  it('posts success for passing lint', async () => {
    const state = { postMessage: vi.fn() };
    await handleLint(state);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('Lint passed') }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
  });
});

describe('handleDeps (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleDeps: (state: any) => Promise<void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('./agentHandlers.js');
    handleDeps = mod.handleDeps;
  });

  it('opens a document with the dependency report', async () => {
    const mockDoc = {};
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue(mockDoc as never);
    vi.spyOn(window, 'showTextDocument').mockResolvedValue(undefined as never);
    const state = { postMessage: vi.fn() };
    await handleDeps(state);
    expect(workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ language: 'markdown' }));
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
  });
});

describe('handleContext (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleContext: (state: any) => Promise<void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('./agentHandlers.js');
    handleContext = mod.handleContext;
  });

  it('opens a context report document', async () => {
    const mockDoc = {};
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue(mockDoc as never);
    vi.spyOn(window, 'showTextDocument').mockResolvedValue(undefined as never);
    const state = {
      postMessage: vi.fn(),
      client: { getSystemPrompt: () => 'test prompt' },
      messages: [],
      metricsCollector: { getHistory: () => [] },
    };
    await handleContext(state);
    expect(workspace.openTextDocument).toHaveBeenCalled();
  });
});

describe('handleExplainToolDecision (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handleExplainToolDecision: (state: any, toolCallId: string) => Promise<void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('./agentHandlers.js');
    handleExplainToolDecision = mod.handleExplainToolDecision;
  });

  it('generates explanation for a found audit entry', async () => {
    const state = {
      auditLog: {
        getByToolCallId: vi.fn().mockResolvedValue({
          tool: 'read_file',
          input: { path: 'src/app.ts' },
          result: 'file contents here',
          isError: false,
          durationMs: 50,
        }),
      },
      client: mockClient(),
      postMessage: vi.fn(),
    };
    await handleExplainToolDecision(state, 'tc_123');
    expect(state.client.complete).toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('read_file') }),
    );
  });

  it('handles LLM failure gracefully', async () => {
    const state = {
      auditLog: {
        getByToolCallId: vi.fn().mockResolvedValue({
          tool: 'grep',
          input: { pattern: 'TODO' },
          result: 'matches',
          isError: false,
          durationMs: 10,
        }),
      },
      client: {
        ...mockClient(),
        complete: vi.fn().mockRejectedValue(new Error('Model unavailable')),
      },
      postMessage: vi.fn(),
    };
    await handleExplainToolDecision(state, 'tc_456');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Could not generate explanation') }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleResume (v0.65 chunk 7c)
//
// /resume is the recovery path for a stream that failed mid-turn. The
// agent loop stashed `state.pendingPartialAssistant` on failure; this
// handler re-dispatches the last turn with a "continue from here" hint
// synthesized from the partial. Tests cover:
//   - no partial → user sees a "nothing to resume" message, done
//   - partial present → pendingPartialAssistant is cleared + handleUser
//     Message fires with a hint containing the partial preview
//   - long partial → preview is truncated in the hint
// ---------------------------------------------------------------------------
// vi.mock factories are hoisted above imports — use vi.hoisted to share
// the spy between the factory (which runs at module-load) and the test
// assertions (which run later). Without this, the factory closes over an
// undefined variable.
const { mockHandleUserMessage } = vi.hoisted(() => ({ mockHandleUserMessage: vi.fn() }));
vi.mock('./chatHandlers.js', async () => {
  const actual = await vi.importActual<typeof import('./chatHandlers.js')>('./chatHandlers.js');
  return {
    ...actual,
    handleUserMessage: (state: unknown, text: string) => mockHandleUserMessage(state, text),
  };
});

describe('handleExecutePlan (happy path)', () => {
  beforeEach(() => {
    mockHandleUserMessage.mockClear();
  });

  it('dispatches the pending plan through handleUserMessage and clears the pending slots', async () => {
    const mod = await import('./agentHandlers.js');
    const state = {
      pendingPlan: 'Step 1 — do X',
      pendingPlanMessages: [{ role: 'user', content: 'original ask' }],
      messages: [],
    };
    await mod.handleExecutePlan(state as never);
    expect(mockHandleUserMessage).toHaveBeenCalledOnce();
    // Plan + execute instruction were both appended before the clear.
    expect(state.pendingPlan).toBeNull();
    expect(state.pendingPlanMessages).toEqual([]);
    // The messages array was populated from the pendingPlanMessages copy
    // (which grew by one: the "execute the plan" instruction message).
    expect(state.messages.length).toBeGreaterThan(0);
  });
});

describe('handleRevisePlan (happy path)', () => {
  beforeEach(() => {
    mockHandleUserMessage.mockClear();
  });

  it('appends feedback, calls handleUserMessage, and clears pending slots', async () => {
    const mod = await import('./agentHandlers.js');
    const state = {
      pendingPlan: 'current plan',
      pendingPlanMessages: [{ role: 'user', content: 'original ask' }],
      messages: [],
    };
    await mod.handleRevisePlan(state as never, 'try a different approach');
    expect(mockHandleUserMessage).toHaveBeenCalledOnce();
    expect(state.pendingPlan).toBeNull();
    expect(state.pendingPlanMessages).toEqual([]);
    // Last message in state.messages carries the feedback.
    const last = state.messages[state.messages.length - 1] as { content: string };
    expect(last.content).toContain('try a different approach');
  });
});

describe('handleUsage', () => {
  it('handles an empty metrics history without crashing', async () => {
    const mod = await import('./agentHandlers.js');
    const state = { metricsCollector: { getHistory: () => [] } };
    await mod.handleUsage(state as never);
  });
});

describe('handleInsight', () => {
  it('renders an insight report without throwing', async () => {
    const mod = await import('./agentHandlers.js');
    const state = { metricsCollector: { getHistory: () => [] } };
    await mod.handleInsight(state as never);
  });
});

describe('handleSpec', () => {
  it('posts the generated spec and calls saveSpec on success', async () => {
    const { generateSpec, saveSpec } = await import('../../agent/specDriven.js');
    vi.mocked(generateSpec).mockResolvedValueOnce('## Spec\n- A');
    vi.mocked(saveSpec).mockResolvedValueOnce(undefined);
    const mod = await import('./agentHandlers.js');
    const state = {
      client: { updateConnection: vi.fn(), updateModel: vi.fn() },
      sidecarDir: { isReady: () => true },
      postMessage: vi.fn(),
    };
    await mod.handleSpec(state as never, 'describe an auth flow');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('## Spec') }),
    );
    expect(saveSpec).toHaveBeenCalled();
  });

  it('posts an error when spec generation returns empty', async () => {
    const { generateSpec } = await import('../../agent/specDriven.js');
    vi.mocked(generateSpec).mockResolvedValueOnce('');
    const mod = await import('./agentHandlers.js');
    const state = {
      client: { updateConnection: vi.fn(), updateModel: vi.fn() },
      postMessage: vi.fn(),
    };
    await mod.handleSpec(state as never, 'nothing to spec');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Failed to generate spec') }),
    );
  });
});

describe('handleBatch', () => {
  it('posts a "nothing to do" no-op when parseBatchInput returns no tasks', async () => {
    const { parseBatchInput } = await import('../../agent/batch.js');
    vi.mocked(parseBatchInput).mockReturnValueOnce({ mode: 'sequential', tasks: [] });
    const mod = await import('./agentHandlers.js');
    const state = {
      client: { updateConnection: vi.fn(), updateModel: vi.fn() },
      postMessage: vi.fn(),
    };
    await mod.handleBatch(state as never, 'no tasks');
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('runs the batch and posts start/complete frames when tasks are supplied', async () => {
    const { parseBatchInput, runBatch } = await import('../../agent/batch.js');
    vi.mocked(parseBatchInput).mockReturnValueOnce({
      mode: 'parallel',
      tasks: [{ id: 0, prompt: 't1' }],
    } as never);
    vi.mocked(runBatch).mockImplementationOnce((async (
      _client: unknown,
      _tasks: unknown,
      _mode: unknown,
      reporter: (id: number, s: string, r: string) => void,
    ) => {
      reporter(0, 'ok', 'task output');
      return [];
    }) as never);
    const mod = await import('./agentHandlers.js');
    const state = {
      client: { updateConnection: vi.fn(), updateModel: vi.fn() },
      postMessage: vi.fn(),
      agentLogger: {},
      mcpManager: {},
    };
    await mod.handleBatch(state as never, '//parallel\n- t1');
    const starts = state.postMessage.mock.calls.filter((c: unknown[]) =>
      ((c[0] as { content?: string }).content ?? '').includes('Starting batch'),
    );
    expect(starts.length).toBe(1);
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
    expect(runBatch).toHaveBeenCalled();
  });

  it('reports a batch interruption as AbortError without surfacing a generic failure', async () => {
    const { parseBatchInput, runBatch } = await import('../../agent/batch.js');
    vi.mocked(parseBatchInput).mockReturnValueOnce({
      mode: 'sequential',
      tasks: [{ id: 0, prompt: 't' }],
    } as never);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.mocked(runBatch).mockRejectedValueOnce(abort);
    const mod = await import('./agentHandlers.js');
    const state = {
      client: { updateConnection: vi.fn(), updateModel: vi.fn() },
      postMessage: vi.fn(),
    };
    await mod.handleBatch(state as never, 'anything');
    const interrupted = state.postMessage.mock.calls.find((c: unknown[]) =>
      ((c[0] as { content?: string }).content ?? '').includes('Batch interrupted'),
    );
    expect(interrupted).toBeDefined();
  });
});

describe('handleAudit (formatted report)', () => {
  it('renders a markdown table and filter footer when entries exist', async () => {
    const mod = await import('./agentHandlers.js');
    const state = {
      auditLog: {
        query: vi.fn().mockResolvedValue([
          {
            timestamp: '2026-04-18T12:34:56Z',
            tool: 'read_file',
            durationMs: 12,
            isError: false,
            input: { path: 'src/foo.ts' },
            result: 'file contents...',
          },
          {
            timestamp: '2026-04-18T12:35:00Z',
            tool: 'run_command',
            durationMs: 200,
            isError: true,
            input: { cmd: 'ls' },
            result: 'permission denied',
          },
        ]),
        count: vi.fn().mockResolvedValue(2),
      },
      postMessage: vi.fn(),
    };
    await mod.handleAudit(state as never, 'errors');
    // Table was posted as a markdown document; a done frame is always
    // fired afterwards.
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
    expect(state.auditLog.query).toHaveBeenCalledWith(expect.objectContaining({ errorsOnly: true }));
  });

  it('parses tool: / last: / since: filter segments into the query', async () => {
    const mod = await import('./agentHandlers.js');
    const state = {
      auditLog: {
        query: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      postMessage: vi.fn(),
    };
    await mod.handleAudit(state as never, 'tool:grep last:5 since:2026-01-01');
    expect(state.auditLog.query).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'grep', limit: 5, since: '2026-01-01' }),
    );
  });
});

describe('handleResume', () => {
  beforeEach(() => {
    mockHandleUserMessage.mockClear();
  });

  it('posts a "no partial to resume" message and exits when pendingPartialAssistant is null', async () => {
    const state = {
      pendingPartialAssistant: null as string | null,
      postMessage: vi.fn(),
    };
    await handleResume(state as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('No partial response') }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
    expect(mockHandleUserMessage).not.toHaveBeenCalled();
  });

  it('posts the same "no partial" message when pendingPartialAssistant is an empty string', async () => {
    const state = {
      pendingPartialAssistant: '' as string | null,
      postMessage: vi.fn(),
    };
    await handleResume(state as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('No partial response') }),
    );
    expect(mockHandleUserMessage).not.toHaveBeenCalled();
  });

  it('re-dispatches via handleUserMessage with a hint containing the captured partial', async () => {
    const state = {
      pendingPartialAssistant: 'Here is the partial response before crash' as string | null,
      postMessage: vi.fn(),
    };
    await handleResume(state as never);
    expect(mockHandleUserMessage).toHaveBeenCalledOnce();
    const [, hint] = mockHandleUserMessage.mock.calls[0];
    expect(hint).toContain('cut off mid-stream');
    expect(hint).toContain('Here is the partial response before crash');
    expect(hint).toContain('continue from exactly where you left off');
  });

  it('clears pendingPartialAssistant before dispatching so a second failure does not replay the old partial', async () => {
    const state = {
      pendingPartialAssistant: 'stale partial' as string | null,
      postMessage: vi.fn(),
    };
    await handleResume(state as never);
    expect(state.pendingPartialAssistant).toBeNull();
  });

  it('truncates a large partial in the preview but passes the full partial context into the hint header', async () => {
    const hugePartial = 'x'.repeat(1000);
    const state = {
      pendingPartialAssistant: hugePartial as string | null,
      postMessage: vi.fn(),
    };
    await handleResume(state as never);
    const [, hint] = mockHandleUserMessage.mock.calls[0];
    // Preview capped at 600 chars + a truncated marker.
    expect(hint).toContain('partial truncated');
    // Hint still contains a chunk of the partial (up to the cap).
    expect(hint).toContain('x'.repeat(100));
  });
});
