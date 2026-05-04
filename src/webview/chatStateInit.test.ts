import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initializeChatSubsystems } from './chatStateInit.js';
import type { ChatState } from './chatState.js';
import type { SideCarConfig } from '../config/settings.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { SidecarDir } from '../config/sidecarDir.js';

// ---------------------------------------------------------------------------
// vi.hoisted() — shared mutable state accessible in vi.mock factories AND
// in the test body. Classes in factories reference this object via closure.
// ---------------------------------------------------------------------------

const shared = vi.hoisted(() => ({
  bgCallbacks: null as Record<string, unknown> | null,
  docIndexerConstructed: false,
  agentMemoryPath: null as string | null,
  agentMemorySession: 'session-abc',
  pinnedMemoryPath: null as string | null,
  auditLogArgs: null as unknown[] | null,
}));

// ---------------------------------------------------------------------------
// Module mocks — real classes so `new Foo()` works in ESM without issues.
// ---------------------------------------------------------------------------

vi.mock('../agent/backgroundAgent.js', () => ({
  BackgroundAgentManager: class {
    constructor(callbacks: Record<string, unknown>) {
      shared.bgCallbacks = callbacks;
    }
    dispose() {}
  },
}));

vi.mock('../config/documentationIndexer.js', () => ({
  DocumentationIndexer: class {
    constructor() {
      shared.docIndexerConstructed = true;
    }
    async initialize() {}
  },
}));

vi.mock('../agent/agentMemory.js', () => ({
  AgentMemory: class {
    constructor(path: string) {
      shared.agentMemoryPath = path;
    }
    async load() {}
    getSessionId() {
      return shared.agentMemorySession;
    }
  },
}));

vi.mock('../agent/memory/pinnedMemory.js', () => ({
  PinnedMemoryStore: class {
    constructor(path: string) {
      shared.pinnedMemoryPath = path;
    }
    async load() {}
  },
}));

vi.mock('../agent/auditLog.js', () => ({
  AuditLog: class {
    constructor(...args: unknown[]) {
      shared.auditLogArgs = args;
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(): ChatState {
  return {
    documentationIndexer: null,
    agentMemory: null,
    pinnedMemoryStore: null,
    auditLog: null,
  } as unknown as ChatState;
}

function makeConfig(overrides: Partial<SideCarConfig> = {}): SideCarConfig {
  return {
    enableDocumentationRAG: false,
    enableAgentMemory: false,
    pinnedMemoryEnabled: false,
    model: 'llama3',
    agentMode: 'cautious',
    ...overrides,
  } as unknown as SideCarConfig;
}

function makeSidecarDir(path = '/tmp/sidecar'): SidecarDir {
  return { getPath: () => path } as unknown as SidecarDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initializeChatSubsystems', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let postMessage: (msg: any) => void;

  beforeEach(() => {
    postMessage = vi.fn();
    shared.bgCallbacks = null;
    shared.docIndexerConstructed = false;
    shared.agentMemoryPath = null;
    shared.pinnedMemoryPath = null;
    shared.auditLogArgs = null;
  });

  it('returns a BackgroundAgentManager', () => {
    const state = makeState();
    const result = initializeChatSubsystems(
      state,
      makeConfig(),
      undefined,
      {} as AgentLogger,
      {} as MCPManager,
      postMessage,
    );
    expect(result).toBeDefined();
    expect(shared.bgCallbacks).not.toBeNull();
  });

  it('does not create DocumentationIndexer when flag is off', () => {
    const state = makeState();
    initializeChatSubsystems(
      state,
      makeConfig({ enableDocumentationRAG: false }),
      undefined,
      {} as AgentLogger,
      {} as MCPManager,
      postMessage,
    );
    expect(shared.docIndexerConstructed).toBe(false);
    expect(state.documentationIndexer).toBeNull();
  });

  it('creates DocumentationIndexer when enableDocumentationRAG is true', () => {
    const state = makeState();
    initializeChatSubsystems(
      state,
      makeConfig({ enableDocumentationRAG: true }),
      undefined,
      {} as AgentLogger,
      {} as MCPManager,
      postMessage,
    );
    expect(shared.docIndexerConstructed).toBe(true);
    expect(state.documentationIndexer).not.toBeNull();
  });

  it('does not create AgentMemory when sidecarDir is missing', () => {
    const state = makeState();
    initializeChatSubsystems(
      state,
      makeConfig({ enableAgentMemory: true }),
      undefined,
      {} as AgentLogger,
      {} as MCPManager,
      postMessage,
    );
    expect(shared.agentMemoryPath).toBeNull();
    expect(state.agentMemory).toBeNull();
  });

  it('creates AgentMemory when enableAgentMemory is true and sidecarDir provided', () => {
    const state = makeState();
    initializeChatSubsystems(
      state,
      makeConfig({ enableAgentMemory: true }),
      makeSidecarDir(),
      {} as AgentLogger,
      {} as MCPManager,
      postMessage,
    );
    expect(shared.agentMemoryPath).toBe('/tmp/sidecar');
    expect(state.agentMemory).not.toBeNull();
  });

  it('creates PinnedMemoryStore when pinnedMemoryEnabled and sidecarDir provided', () => {
    const state = makeState();
    initializeChatSubsystems(
      state,
      makeConfig({ pinnedMemoryEnabled: true }),
      makeSidecarDir(),
      {} as AgentLogger,
      {} as MCPManager,
      postMessage,
    );
    expect(shared.pinnedMemoryPath).toBe('/tmp/sidecar');
    expect(state.pinnedMemoryStore).not.toBeNull();
  });

  it('does not create PinnedMemoryStore when sidecarDir is missing', () => {
    const state = makeState();
    initializeChatSubsystems(
      state,
      makeConfig({ pinnedMemoryEnabled: true }),
      undefined,
      {} as AgentLogger,
      {} as MCPManager,
      postMessage,
    );
    expect(shared.pinnedMemoryPath).toBeNull();
    expect(state.pinnedMemoryStore).toBeNull();
  });

  it('creates AuditLog when sidecarDir is provided', () => {
    const state = makeState();
    initializeChatSubsystems(state, makeConfig(), makeSidecarDir(), {} as AgentLogger, {} as MCPManager, postMessage);
    expect(shared.auditLogArgs).not.toBeNull();
    expect(state.auditLog).not.toBeNull();
  });

  it('does not create AuditLog when sidecarDir is missing', () => {
    const state = makeState();
    initializeChatSubsystems(state, makeConfig(), undefined, {} as AgentLogger, {} as MCPManager, postMessage);
    expect(shared.auditLogArgs).toBeNull();
    expect(state.auditLog).toBeNull();
  });

  it('uses agentMemory sessionId for AuditLog when agentMemory is wired', () => {
    const state = makeState();
    initializeChatSubsystems(
      state,
      makeConfig({ enableAgentMemory: true }),
      makeSidecarDir(),
      {} as AgentLogger,
      {} as MCPManager,
      postMessage,
    );
    expect(shared.auditLogArgs?.[1]).toBe('session-abc');
  });

  it('falls back to generated sessionId when agentMemory is not wired', () => {
    const state = makeState();
    initializeChatSubsystems(
      state,
      makeConfig({ enableAgentMemory: false }),
      makeSidecarDir(),
      {} as AgentLogger,
      {} as MCPManager,
      postMessage,
    );
    expect(typeof shared.auditLogArgs?.[1]).toBe('string');
    expect(String(shared.auditLogArgs?.[1])).toMatch(/^s-\d+$/);
  });

  it('bgManager onStatusChange callback posts bgStatusUpdate', () => {
    const state = makeState();
    initializeChatSubsystems(state, makeConfig(), undefined, {} as AgentLogger, {} as MCPManager, postMessage);
    const fakeRun = { id: 'bg-1', status: 'running' };
    (shared.bgCallbacks!.onStatusChange as (r: unknown) => void)(fakeRun);
    expect(postMessage).toHaveBeenCalledWith({ command: 'bgStatusUpdate', bgRun: fakeRun });
  });

  it('bgManager onOutput callback posts bgOutput', () => {
    const state = makeState();
    initializeChatSubsystems(state, makeConfig(), undefined, {} as AgentLogger, {} as MCPManager, postMessage);
    (shared.bgCallbacks!.onOutput as (id: string, chunk: string) => void)('bg-1', 'chunk');
    expect(postMessage).toHaveBeenCalledWith({ command: 'bgOutput', bgRunId: 'bg-1', content: 'chunk' });
  });

  it('bgManager onComplete posts success summary', () => {
    const state = makeState();
    initializeChatSubsystems(state, makeConfig(), undefined, {} as AgentLogger, {} as MCPManager, postMessage);
    const run = { id: 'bg-1', status: 'completed', task: 'lint', toolCalls: 3, output: 'all good', error: undefined };
    (shared.bgCallbacks!.onComplete as (r: typeof run) => void)(run);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'bgComplete', bgRun: run }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('completed') }),
    );
    expect(postMessage).toHaveBeenCalledWith({ command: 'done' });
  });

  it('bgManager onComplete posts failure summary when task failed', () => {
    const state = makeState();
    initializeChatSubsystems(state, makeConfig(), undefined, {} as AgentLogger, {} as MCPManager, postMessage);
    const run = { id: 'bg-1', status: 'failed', task: 'lint', toolCalls: 0, output: '', error: 'OOM' };
    (shared.bgCallbacks!.onComplete as (r: typeof run) => void)(run);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('failed') }),
    );
  });
});
