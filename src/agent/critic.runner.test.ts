/**
 * Integration tests for the loop-side adversarial critic runner. The
 * pure-logic pieces (prompt builders, response parser, severity dispatch)
 * are covered in critic.test.ts. This file focuses on the wiring:
 * trigger selection, per-file injection cap, blocking vs. passive
 * surfacing, error swallowing, and abort-signal honoring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';

// Mock vscode surfaces touched by `buildCriticDiff` (workspace folder +
// file read for the current content). The `readFile` mock resolves with
// a UTF-8 buffer whose content we control per test.
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock-root' } }],
    fs: { readFile: readFileMock },
    getConfiguration: () => ({ get: () => undefined }),
  },
  Uri: {
    joinPath: (base: { fsPath: string }, ...segs: string[]) => ({
      fsPath: base.fsPath + '/' + segs.join('/'),
    }),
  },
  // Minimal EventEmitter stub: SpendTracker and other modules construct
  // one at load time via `new EventEmitter()`. We only need the `event`
  // getter and `.fire()` to noop — nothing in the critic runner path
  // actually subscribes.
  EventEmitter: class {
    readonly event = () => ({ dispose: () => undefined });
    fire = () => undefined;
    dispose = () => undefined;
  },
}));

// The loop module imports getToolDefinitions + getDiagnostics at module
// load time; stub them so we don't drag in the whole tools registry.
vi.mock('./tools.js', () => ({
  getToolDefinitions: () => [],
  getDiagnostics: async () => 'No diagnostics',
}));

import { runCriticChecks, type RunCriticOptions } from './loop.js';
import type { AgentCallbacks } from './loop.js';
import type { SideCarClient } from '../ollama/client.js';
import type { ChangeLog, FileChange } from './changelog.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeClient(respond: (prompt: string) => string | Promise<string>): {
  client: SideCarClient;
  calls: { prompt: string }[];
} {
  const calls: { prompt: string }[] = [];
  const client = {
    completeWithOverrides: vi.fn(
      async (_system: string, messages: { role: string; content: string }[]): Promise<string> => {
        const prompt = messages[0]?.content ?? '';
        calls.push({ prompt });
        return respond(prompt);
      },
    ),
  } as unknown as SideCarClient;
  return { client, calls };
}

function makeChangelog(changes: FileChange[] = []): ChangeLog {
  return {
    getChanges: () => [...changes],
    snapshotFile: vi.fn(),
    hasChanges: () => changes.length > 0,
    rollbackAll: vi.fn(),
  } as unknown as ChangeLog;
}

function makeCallbacks(): { callbacks: AgentCallbacks; textChunks: string[] } {
  const textChunks: string[] = [];
  const callbacks: AgentCallbacks = {
    onText: (text: string) => {
      textChunks.push(text);
    },
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  };
  return { callbacks, textChunks };
}

function baseOptions(overrides: Partial<RunCriticOptions> = {}): RunCriticOptions {
  const { callbacks } = makeCallbacks();
  const { client } = makeClient(() => '{"findings": []}');
  return {
    client,
    config: {
      criticEnabled: true,
      criticModel: '',
      criticBlockOnHighSeverity: true,
    } as RunCriticOptions['config'],
    pendingToolUses: [],
    toolResults: [],
    changelog: makeChangelog(),
    fullText: '',
    callbacks,
    logger: undefined,
    signal: new AbortController().signal,
    criticInjectionsByFile: new Map(),
    maxPerFile: 2,
    ...overrides,
  };
}

// Canonical pair of a successful write_file tool_use + tool_result.
function editPair(filePath: string): {
  use: ToolUseContentBlock;
  result: ToolResultContentBlock;
} {
  return {
    use: {
      type: 'tool_use',
      id: `tu_${filePath}`,
      name: 'write_file',
      input: { path: filePath, content: 'new content' },
    },
    result: {
      type: 'tool_result',
      tool_use_id: `tu_${filePath}`,
      content: `File written: ${filePath}`,
      is_error: false,
    },
  };
}

function failedTestPair(output: string): {
  use: ToolUseContentBlock;
  result: ToolResultContentBlock;
} {
  return {
    use: {
      type: 'tool_use',
      id: 'tu_test',
      name: 'run_tests',
      input: {},
    },
    result: {
      type: 'tool_result',
      tool_use_id: 'tu_test',
      content: output,
      is_error: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCriticChecks', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    // Default: every file read returns a plausible post-edit buffer.
    readFileMock.mockResolvedValue(Buffer.from('new content', 'utf-8'));
  });

  describe('trigger selection', () => {
    it('returns null when there are no edits and no failed tests', async () => {
      const { client, calls } = makeClient(() => '{"findings": []}');
      const result = await runCriticChecks(baseOptions({ client }));
      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('fires the critic on a successful write_file', async () => {
      const { use, result } = editPair('src/foo.ts');
      const { client, calls } = makeClient(() => '{"findings": []}');
      await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [use],
          toolResults: [result],
        }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].prompt).toContain('src/foo.ts');
      expect(calls[0].prompt).toContain('Attack this change');
    });

    it('skips write_file calls that errored', async () => {
      const { use } = editPair('src/foo.ts');
      const errorResult: ToolResultContentBlock = {
        type: 'tool_result',
        tool_use_id: use.id,
        content: 'write failed',
        is_error: true,
      };
      const { client, calls } = makeClient(() => '{"findings": []}');
      await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [use],
          toolResults: [errorResult],
        }),
      );
      expect(calls).toHaveLength(0);
    });

    it('fires the critic on a failed run_tests call with recent edits attached', async () => {
      const edit = editPair('src/foo.ts');
      const fail = failedTestPair('FAIL: expected 3, got 4');
      const { client, calls } = makeClient((prompt) => {
        // Two triggers fire — one for the edit, one for the test failure.
        // Distinguish them by prompt content.
        if (prompt.includes('Test output')) return '{"findings": []}';
        return '{"findings": []}';
      });
      await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [edit.use, fail.use],
          toolResults: [edit.result, fail.result],
        }),
      );
      expect(calls).toHaveLength(2);
      const testFailPrompt = calls.find((c) => c.prompt.includes('Test output'));
      expect(testFailPrompt).toBeDefined();
      expect(testFailPrompt!.prompt).toContain('FAIL: expected 3');
      expect(testFailPrompt!.prompt).toContain('src/foo.ts'); // recentEdits attached
    });
  });

  describe('severity dispatch', () => {
    it('returns a blocking injection when high-severity finding + blockOnHighSeverity=true', async () => {
      const edit = editPair('src/foo.ts');
      const { client } = makeClient(
        () =>
          '{"findings": [{"severity": "high", "title": "Race condition", "evidence": "lock released before write"}]}',
      );
      const result = await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [edit.use],
          toolResults: [edit.result],
        }),
      );
      expect(result).not.toBeNull();
      expect(result).toContain('Race condition');
      expect(result).toContain('lock released before write');
      expect(result).toContain('Critic review — attempt 1 of 2');
    });

    it('returns null when high finding but blockOnHighSeverity=false', async () => {
      const edit = editPair('src/foo.ts');
      const { client } = makeClient(
        () => '{"findings": [{"severity": "high", "title": "Bad", "evidence": "very bad"}]}',
      );
      const { callbacks, textChunks } = makeCallbacks();
      const result = await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [edit.use],
          toolResults: [edit.result],
          callbacks,
          config: {
            criticEnabled: true,
            criticModel: '',
            criticBlockOnHighSeverity: false,
          } as RunCriticOptions['config'],
        }),
      );
      expect(result).toBeNull();
      // Chat annotation still surfaces even when not blocking.
      expect(textChunks.join('')).toContain('Bad');
    });

    it('surfaces low-severity findings as chat annotations without blocking', async () => {
      const edit = editPair('src/foo.ts');
      const { client } = makeClient(
        () => '{"findings": [{"severity": "low", "title": "Minor nit", "evidence": "not urgent"}]}',
      );
      const { callbacks, textChunks } = makeCallbacks();
      const result = await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [edit.use],
          toolResults: [edit.result],
          callbacks,
        }),
      );
      expect(result).toBeNull();
      expect(textChunks.join('')).toContain('Minor nit');
    });
  });

  describe('per-file injection cap', () => {
    it('skips edits on files that already hit maxPerFile injections', async () => {
      const edit = editPair('src/foo.ts');
      const cap = new Map<string, number>([['src/foo.ts', 2]]); // already at cap
      const { client, calls } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');
      const result = await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [edit.use],
          toolResults: [edit.result],
          criticInjectionsByFile: cap,
        }),
      );
      // Cap reached — critic never called for this file, no injection.
      expect(calls).toHaveLength(0);
      expect(result).toBeNull();
    });

    it('increments the counter after a blocking injection', async () => {
      const edit = editPair('src/foo.ts');
      const cap = new Map<string, number>();
      const { client } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');
      await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [edit.use],
          toolResults: [edit.result],
          criticInjectionsByFile: cap,
        }),
      );
      expect(cap.get('src/foo.ts')).toBe(1);
    });

    it('after one block, a second run on the same file increments to max and the third is skipped', async () => {
      const cap = new Map<string, number>();
      const { client } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');

      const run = async () => {
        const edit = editPair('src/foo.ts');
        return runCriticChecks(
          baseOptions({
            client,
            pendingToolUses: [edit.use],
            toolResults: [edit.result],
            criticInjectionsByFile: cap,
          }),
        );
      };

      const r1 = await run();
      expect(r1).not.toBeNull();
      expect(cap.get('src/foo.ts')).toBe(1);

      const r2 = await run();
      expect(r2).not.toBeNull();
      expect(cap.get('src/foo.ts')).toBe(2);

      // Third: over cap → critic not invoked, null.
      const r3 = await run();
      expect(r3).toBeNull();
    });
  });

  describe('error handling', () => {
    it('logs and skips when the critic response is malformed', async () => {
      const edit = editPair('src/foo.ts');
      const { client } = makeClient(() => 'this is not json at all');
      const result = await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [edit.use],
          toolResults: [edit.result],
        }),
      );
      expect(result).toBeNull();
    });

    it('swallows network errors from the critic LLM call', async () => {
      const edit = editPair('src/foo.ts');
      const client = {
        completeWithOverrides: vi.fn(async () => {
          throw new Error('Network timeout');
        }),
      } as unknown as SideCarClient;
      const result = await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [edit.use],
          toolResults: [edit.result],
        }),
      );
      expect(result).toBeNull();
    });

    it('returns null early when the abort signal fires mid-loop', async () => {
      const edit = editPair('src/foo.ts');
      const controller = new AbortController();
      controller.abort();
      const { client, calls } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');
      const result = await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [edit.use],
          toolResults: [edit.result],
          signal: controller.signal,
        }),
      );
      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });
});
