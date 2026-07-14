/**
 * Integration tests for the loop-side adversarial critic runner. The
 * pure-logic pieces (prompt builders, response parser, severity dispatch)
 * are covered in critic.test.ts. This file focuses on the wiring:
 * trigger selection, per-file injection cap, blocking vs. passive
 * surfacing, error swallowing, and abort-signal honoring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { runCriticChecks, type RunCriticOptions } from './loop/criticHook.js';
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
    // Phase 4b.3 wiring: criticHook consults the router before each
    // dispatch. Tests that don't exercise routing return null to take
    // the no-op branch.
    routeForDispatch: vi.fn(() => null),
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
    editedFilePaths: [],
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
    it('returns null when the run edited nothing', async () => {
      const { client, calls } = makeClient(() => '{"findings": []}');
      const result = await runCriticChecks(baseOptions({ client }));
      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('reviews each file the run edited', async () => {
      const { client, calls } = makeClient(() => '{"findings": []}');
      await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
        }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].prompt).toContain('src/foo.ts');
      expect(calls[0].prompt).toContain('Attack this change');
    });

    it('tags the critic dispatch with role=critic for the router ', async () => {
      const { client } = makeClient(() => '{"findings": []}');
      await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
        }),
      );
      const routeMock = (client as unknown as { routeForDispatch: ReturnType<typeof vi.fn> }).routeForDispatch;
      expect(routeMock).toHaveBeenCalled();
      expect(routeMock.mock.calls[0][0]).toMatchObject({ role: 'critic' });
    });
  });

  describe('severity dispatch', () => {
    it('returns a blocking injection when high-severity finding + blockOnHighSeverity=true', async () => {
      const { client } = makeClient(
        () =>
          '{"findings": [{"severity": "high", "title": "Race condition", "evidence": "lock released before write"}]}',
      );
      const result = await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
        }),
      );
      expect(result).not.toBeNull();
      expect(result).toContain('Race condition');
      expect(result).toContain('lock released before write');
      expect(result).toContain('Critic review — attempt 1 of 2');
    });

    it('returns null when high finding but blockOnHighSeverity=false', async () => {
      const { client } = makeClient(
        () => '{"findings": [{"severity": "high", "title": "Bad", "evidence": "very bad"}]}',
      );
      const { callbacks, textChunks } = makeCallbacks();
      const result = await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
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
      const { client } = makeClient(
        () => '{"findings": [{"severity": "low", "title": "Minor nit", "evidence": "not urgent"}]}',
      );
      const { callbacks, textChunks } = makeCallbacks();
      const result = await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
          callbacks,
        }),
      );
      expect(result).toBeNull();
      expect(textChunks.join('')).toContain('Minor nit');
    });
  });

  describe('per-file injection cap', () => {
    it('skips edits on files that already hit maxPerFile injections', async () => {
      const cap = new Map<string, number>([['src/foo.ts', 2]]); // already at cap
      const { client, calls } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');
      const result = await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
          criticInjectionsByFile: cap,
        }),
      );
      // Cap reached — critic never called for this file, no injection.
      expect(calls).toHaveLength(0);
      expect(result).toBeNull();
    });

    it('increments the counter after a blocking injection', async () => {
      const cap = new Map<string, number>();
      const { client } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');
      await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
          criticInjectionsByFile: cap,
        }),
      );
      expect(cap.get('src/foo.ts')).toBe(1);
    });

    it('after one block, a second run on the same file increments to max and the third is skipped', async () => {
      const cap = new Map<string, number>();
      const { client } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');

      const run = async () => {
        return runCriticChecks(
          baseOptions({
            client,
            editedFilePaths: ['src/foo.ts'],
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
      const { client } = makeClient(() => 'this is not json at all');
      const result = await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
        }),
      );
      expect(result).toBeNull();
    });

    it('swallows network errors from the critic LLM call', async () => {
      const client = {
        completeWithOverrides: vi.fn(async () => {
          throw new Error('Network timeout');
        }),
        routeForDispatch: vi.fn(() => null),
      } as unknown as SideCarClient;
      const result = await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
        }),
      );
      expect(result).toBeNull();
    });

    it('returns null early when the abort signal fires mid-loop', async () => {
      const controller = new AbortController();
      controller.abort();
      const { client, calls } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');
      const result = await runCriticChecks(
        baseOptions({
          client,
          editedFilePaths: ['src/foo.ts'],
          signal: controller.signal,
        }),
      );
      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });

  describe('session stats ', () => {
    it('increments totalCalls on every critic LLM call', async () => {
      const { getCriticStats, resetCriticStats } = await import('./loop/criticHook.js');
      resetCriticStats();
      const { client } = makeClient(() => '{"findings": []}');
      await runCriticChecks(baseOptions({ client, editedFilePaths: ['src/foo.ts'] }));
      expect(getCriticStats().totalCalls).toBe(1);
    });

    it('increments blockedTurns when high-severity findings trigger an injection', async () => {
      const { getCriticStats, resetCriticStats } = await import('./loop/criticHook.js');
      resetCriticStats();
      const { client } = makeClient(
        () =>
          '{"findings": [{"severity": "high", "title": "null pointer", "evidence": "line 5", "fix": "null-check"}]}',
      );
      const r = await runCriticChecks(baseOptions({ client, editedFilePaths: ['src/foo.ts'] }));
      expect(r).not.toBeNull(); // blocking injection returned
      const stats = getCriticStats();
      expect(stats.blockedTurns).toBe(1);
      expect(stats.lastBlockedReason).toContain('null pointer');
    });

    it('does NOT increment blockedTurns on low-severity findings (non-blocking)', async () => {
      const { getCriticStats, resetCriticStats } = await import('./loop/criticHook.js');
      resetCriticStats();
      const { client } = makeClient(
        () => '{"findings": [{"severity": "low", "title": "style nit", "evidence": "line 5", "fix": "rename"}]}',
      );
      await runCriticChecks(baseOptions({ client, editedFilePaths: ['src/foo.ts'] }));
      expect(getCriticStats().blockedTurns).toBe(0);
      // But the call still happened — totalCalls is the observability proxy.
      expect(getCriticStats().totalCalls).toBe(1);
    });

    it('resetCriticStats clears every counter', async () => {
      const { getCriticStats, resetCriticStats } = await import('./loop/criticHook.js');
      // Populate via a blocking call first.
      const { client } = makeClient(
        () => '{"findings": [{"severity": "high", "title": "oops", "evidence": "x", "fix": "y"}]}',
      );
      await runCriticChecks(baseOptions({ client, editedFilePaths: ['src/foo.ts'] }));
      expect(getCriticStats().blockedTurns).toBeGreaterThan(0);

      resetCriticStats();
      expect(getCriticStats()).toEqual({ blockedTurns: 0, lastBlockedReason: '', totalCalls: 0 });
    });
  });

  // per-test-output-hash cap. Prior to this release the
  // test_failure trigger path was unbounded: a gate-forced test run
  // that kept failing would fire the critic every iteration until the
  // outer maxIterations cap tripped. Now capped on a normalized hash
  // so cosmetic re-runs of the same failure (different timestamps /
  // addresses) collapse into one bucket and stop re-firing after N
  // blocks.
});
