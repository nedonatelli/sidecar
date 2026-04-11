import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMcpStatus } from './agentHandlers.js';
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
