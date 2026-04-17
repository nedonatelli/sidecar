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
import { normalizeTestOutput, hashTestOutput } from './loop/criticHook.js';
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

  describe('session stats (v0.62.1 p.1b)', () => {
    it('increments totalCalls on every critic LLM call', async () => {
      const { getCriticStats, resetCriticStats } = await import('./loop/criticHook.js');
      resetCriticStats();
      const { use, result } = editPair('src/foo.ts');
      const { client } = makeClient(() => '{"findings": []}');
      await runCriticChecks(baseOptions({ client, pendingToolUses: [use], toolResults: [result] }));
      expect(getCriticStats().totalCalls).toBe(1);
    });

    it('increments blockedTurns when high-severity findings trigger an injection', async () => {
      const { getCriticStats, resetCriticStats } = await import('./loop/criticHook.js');
      resetCriticStats();
      const { use, result } = editPair('src/foo.ts');
      const { client } = makeClient(
        () =>
          '{"findings": [{"severity": "high", "title": "null pointer", "evidence": "line 5", "fix": "null-check"}]}',
      );
      const r = await runCriticChecks(baseOptions({ client, pendingToolUses: [use], toolResults: [result] }));
      expect(r).not.toBeNull(); // blocking injection returned
      const stats = getCriticStats();
      expect(stats.blockedTurns).toBe(1);
      expect(stats.lastBlockedReason).toContain('null pointer');
    });

    it('does NOT increment blockedTurns on low-severity findings (non-blocking)', async () => {
      const { getCriticStats, resetCriticStats } = await import('./loop/criticHook.js');
      resetCriticStats();
      const { use, result } = editPair('src/foo.ts');
      const { client } = makeClient(
        () => '{"findings": [{"severity": "low", "title": "style nit", "evidence": "line 5", "fix": "rename"}]}',
      );
      await runCriticChecks(baseOptions({ client, pendingToolUses: [use], toolResults: [result] }));
      expect(getCriticStats().blockedTurns).toBe(0);
      // But the call still happened — totalCalls is the observability proxy.
      expect(getCriticStats().totalCalls).toBe(1);
    });

    it('resetCriticStats clears every counter', async () => {
      const { getCriticStats, resetCriticStats } = await import('./loop/criticHook.js');
      // Populate via a blocking call first.
      const { use, result } = editPair('src/foo.ts');
      const { client } = makeClient(
        () => '{"findings": [{"severity": "high", "title": "oops", "evidence": "x", "fix": "y"}]}',
      );
      await runCriticChecks(baseOptions({ client, pendingToolUses: [use], toolResults: [result] }));
      expect(getCriticStats().blockedTurns).toBeGreaterThan(0);

      resetCriticStats();
      expect(getCriticStats()).toEqual({ blockedTurns: 0, lastBlockedReason: '', totalCalls: 0 });
    });
  });

  // v0.63.0 — per-test-output-hash cap. Prior to this release the
  // test_failure trigger path was unbounded: a gate-forced test run
  // that kept failing would fire the critic every iteration until the
  // outer maxIterations cap tripped. Now capped on a normalized hash
  // so cosmetic re-runs of the same failure (different timestamps /
  // addresses) collapse into one bucket and stop re-firing after N
  // blocks.
  describe('per-test-output-hash cap (v0.63.0)', () => {
    it('fires the critic on a test_failure and increments the per-hash counter', async () => {
      const hashMap = new Map<string, number>();
      const { client } = makeClient(
        () => '{"findings": [{"severity": "high", "title": "flaky assertion", "evidence": "line 12"}]}',
      );
      const { use, result } = failedTestPair('FAIL foo.test.ts > adds\n  Expected 3, got 4');

      const r = await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [use],
          toolResults: [result],
          criticInjectionsByTestHash: hashMap,
          maxPerTestHash: 2,
        }),
      );

      expect(r).not.toBeNull();
      // One hash bucket, counter = 1.
      expect(hashMap.size).toBe(1);
      expect([...hashMap.values()][0]).toBe(1);
    });

    it('skips re-firing when the same test output hash has hit the cap', async () => {
      const hashMap = new Map<string, number>();
      const { client } = makeClient(
        () => '{"findings": [{"severity": "high", "title": "boom", "evidence": "line 1"}]}',
      );
      const { use, result } = failedTestPair('FAIL the same failure output every time');

      const run = () =>
        runCriticChecks(
          baseOptions({
            client,
            pendingToolUses: [use],
            toolResults: [result],
            criticInjectionsByTestHash: hashMap,
            maxPerTestHash: 2,
          }),
        );

      const r1 = await run();
      const r2 = await run();
      const r3 = await run();

      // First two blocks land, third is capped.
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r3).toBeNull();
      // Counter plateaus at 2 — the third call never incremented
      // because it short-circuited before the LLM call.
      expect([...hashMap.values()][0]).toBe(2);
    });

    it('cosmetic-only differences (timestamps, memory addresses) collapse to the same hash', async () => {
      const hashMap = new Map<string, number>();
      const { client } = makeClient(() => '{"findings": [{"severity": "high", "title": "leak", "evidence": "x"}]}');

      // Same underlying failure, different timestamps + addresses.
      const pair1 = failedTestPair('FAIL 2026-04-17T10:00:00Z: memory at 0x7fff5fbff8a0 — leak detected');
      const pair2 = failedTestPair('FAIL 2026-04-17T10:05:42Z: memory at 0x7fff5fbff9b4 — leak detected');

      await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [pair1.use],
          toolResults: [pair1.result],
          criticInjectionsByTestHash: hashMap,
          maxPerTestHash: 2,
        }),
      );
      await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [pair2.use],
          toolResults: [pair2.result],
          criticInjectionsByTestHash: hashMap,
          maxPerTestHash: 2,
        }),
      );

      // Both runs landed under the SAME hash bucket — counter = 2.
      expect(hashMap.size).toBe(1);
      expect([...hashMap.values()][0]).toBe(2);
    });

    it('materially-different failures hash to different buckets', async () => {
      const hashMap = new Map<string, number>();
      const { client } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');

      const pairA = failedTestPair('FAIL foo.test.ts > parses integers\n  Expected 42, got NaN');
      const pairB = failedTestPair('FAIL bar.test.ts > writes file\n  EACCES permission denied');

      await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [pairA.use],
          toolResults: [pairA.result],
          criticInjectionsByTestHash: hashMap,
          maxPerTestHash: 2,
        }),
      );
      await runCriticChecks(
        baseOptions({
          client,
          pendingToolUses: [pairB.use],
          toolResults: [pairB.result],
          criticInjectionsByTestHash: hashMap,
          maxPerTestHash: 2,
        }),
      );

      // Two separate buckets — different failure signatures get
      // tracked independently so the critic can still analyze each.
      expect(hashMap.size).toBe(2);
    });

    it('legacy callers (no criticInjectionsByTestHash / maxPerTestHash) keep working unbounded', async () => {
      // Back-compat: callers that pre-date v0.63.0 don't pass the new
      // map or cap. The runner must not crash and must keep the prior
      // unbounded behavior for them.
      const { client } = makeClient(() => '{"findings": [{"severity": "high", "title": "x", "evidence": "y"}]}');
      const { use, result } = failedTestPair('FAIL something');

      const run = () =>
        runCriticChecks(
          baseOptions({
            client,
            pendingToolUses: [use],
            toolResults: [result],
            // No criticInjectionsByTestHash, no maxPerTestHash.
          }),
        );

      // All three calls return blocking injections — no cap applied
      // for legacy callers.
      const r1 = await run();
      const r2 = await run();
      const r3 = await run();
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r3).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeTestOutput + hashTestOutput — pure helpers
// ---------------------------------------------------------------------------

describe('normalizeTestOutput (v0.63.0)', () => {
  it('strips ISO-8601 timestamps', () => {
    const a = normalizeTestOutput('FAIL 2026-04-17T10:00:00Z: assertion failed');
    const b = normalizeTestOutput('FAIL 2026-04-17T23:59:59.999Z: assertion failed');
    expect(a).toBe(b);
    expect(a).toContain('<TIMESTAMP>');
  });

  it('strips hex memory addresses', () => {
    const a = normalizeTestOutput('leak at 0x7fff5fbff8a0');
    const b = normalizeTestOutput('leak at 0xdeadbeef01');
    expect(a).toBe(b);
    expect(a).toContain('<ADDR>');
  });

  it('strips tmp paths (macOS /var/folders + Linux /tmp)', () => {
    const mac = normalizeTestOutput('wrote to /var/folders/abc/T/vitest-xyz/out.log');
    const linux = normalizeTestOutput('wrote to /tmp/vitest-pqr/out.log');
    expect(mac).toContain('<TMP>');
    expect(linux).toContain('<TMP>');
  });

  it('strips duration measurements', () => {
    const a = normalizeTestOutput('test completed in 1.23s');
    const b = normalizeTestOutput('test completed in 847ms');
    expect(a).toBe(b);
    expect(a).toContain('<DUR>');
  });

  it('collapses whitespace runs so indentation differences do not matter', () => {
    const a = normalizeTestOutput('FAIL\n   Expected: 3\n   Received: 4');
    const b = normalizeTestOutput('FAIL\nExpected: 3\n\tReceived: 4');
    expect(a).toBe(b);
  });

  it('preserves the actual failure signal (assertion text, error codes)', () => {
    // The whole point of normalization is collapsing noise WITHOUT
    // collapsing signal. This test pins that the material content
    // (Expected/Received/error codes) survives the transform.
    const out = normalizeTestOutput('FAIL 2026-04-17T10:00:00Z\n   Expected: 42\n   Received: NaN\n   took 150ms');
    expect(out).toContain('Expected: 42');
    expect(out).toContain('Received: NaN');
    expect(out).toContain('FAIL');
  });
});

describe('hashTestOutput (v0.63.0)', () => {
  it('returns a hex string', () => {
    const h = hashTestOutput('any text at all');
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('is stable — same input always produces the same hash', () => {
    const input = 'FAIL Expected 3 got 4';
    expect(hashTestOutput(input)).toBe(hashTestOutput(input));
  });

  it('different inputs produce different hashes (typical case — not cryptographic)', () => {
    expect(hashTestOutput('failure A')).not.toBe(hashTestOutput('failure B'));
    expect(hashTestOutput('FAIL foo')).not.toBe(hashTestOutput('FAIL bar'));
  });
});
