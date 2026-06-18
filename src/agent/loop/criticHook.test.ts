import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';
import {
  applyCritic,
  applyAnalysisCritic,
  gatherReadEvidence,
  runCriticChecks,
  normalizeTestOutput,
  hashTestOutput,
  getCriticStats,
  resetCriticStats,
} from './criticHook.js';
import { parseCriticResponse, splitBySeverity } from '../critic.js';
vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn().mockReturnValue({ criticEnabled: false }),
}));
vi.mock('../critic.js', () => ({
  CRITIC_SYSTEM_PROMPT: 'critic system prompt',
  ANALYSIS_CRITIC_SYSTEM_PROMPT: 'analysis critic prompt',
  CRITIC_FINDINGS_SCHEMA: { type: 'object' },
  buildEditCriticPrompt: vi.fn().mockReturnValue('please review this edit'),
  buildTestFailureCriticPrompt: vi.fn().mockReturnValue('please review this failure'),
  buildAnalysisCriticPrompt: vi.fn().mockReturnValue('please fact-check this analysis'),
  parseCriticResponse: vi.fn().mockReturnValue({ malformed: false, explicitlyClean: false, findings: [] }),
  splitBySeverity: vi.fn().mockReturnValue({ high: [], low: [] }),
  formatFindingsForChat: vi.fn().mockReturnValue('formatted findings'),
  buildCriticInjection: vi.fn().mockReturnValue('CRITIC: found issues'),
}));

// ---------------------------------------------------------------------------
// normalizeTestOutput
// ---------------------------------------------------------------------------

describe('normalizeTestOutput', () => {
  it('replaces variable memory addresses', () => {
    const out = normalizeTestOutput('at 0x7f3a12345678');
    expect(out).not.toContain('0x7f3a12345678');
  });

  it('replaces durations like 0.042s', () => {
    const out = normalizeTestOutput('finished in 0.042s');
    expect(out).not.toContain('0.042');
  });

  it('passes through text with no variable data unchanged in structure', () => {
    const out = normalizeTestOutput('Test failed: assertion error');
    expect(out).toContain('Test failed');
    expect(out).toContain('assertion error');
  });
});

// ---------------------------------------------------------------------------
// hashTestOutput
// ---------------------------------------------------------------------------

describe('hashTestOutput', () => {
  it('returns a non-empty string for non-empty input', () => {
    const h = hashTestOutput('AssertionError: expected 1 to be 2');
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });

  it('returns the same hash for the same input', () => {
    const h1 = hashTestOutput('error text');
    const h2 = hashTestOutput('error text');
    expect(h1).toBe(h2);
  });

  it('returns different hashes for different inputs', () => {
    expect(hashTestOutput('error A')).not.toBe(hashTestOutput('error B'));
  });
});

// ---------------------------------------------------------------------------
// getCriticStats / resetCriticStats
// ---------------------------------------------------------------------------

describe('criticStats', () => {
  beforeEach(() => resetCriticStats());

  it('getCriticStats returns an object with zero counts after reset', () => {
    const stats = getCriticStats();
    expect(typeof stats).toBe('object');
  });

  it('resetCriticStats does not throw', () => {
    expect(() => resetCriticStats()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyCritic
// ---------------------------------------------------------------------------

describe('applyCritic', () => {
  it('is a no-op when criticEnabled is false', async () => {
    const state = {
      messages: [],
      changelog: null,
      logger: null,
      criticInjectionsByFile: new Map(),
      criticInjectionsByTestHash: new Map(),
    } as never;
    const client = {} as never;
    const config = { criticEnabled: false } as never;
    const callbacks = { onText: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onDone: vi.fn() };
    const signal = new AbortController().signal;

    await applyCritic(state, client, config, [], [], 'agent text', callbacks, signal);
    expect((state as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it('is a no-op when signal is already aborted', async () => {
    const state = {
      messages: [],
      changelog: null,
      logger: null,
      criticInjectionsByFile: new Map(),
      criticInjectionsByTestHash: new Map(),
    } as never;
    const ac = new AbortController();
    ac.abort();

    await applyCritic(
      state,
      {} as never,
      { criticEnabled: true } as never,
      [],
      [],
      'text',
      {
        onText: vi.fn(),
        onToolCall: vi.fn(),
        onToolResult: vi.fn(),
        onDone: vi.fn(),
      },
      ac.signal,
    );
    expect((state as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it('runs the critic and pushes no injection when runCriticChecks returns null', async () => {
    const state = {
      messages: [],
      changelog: undefined,
      logger: undefined,
      criticInjectionsByFile: new Map(),
      criticInjectionsByTestHash: new Map(),
    } as never;
    const client = {} as never;
    const config = { criticEnabled: true } as never;
    const callbacks = { onText: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onDone: vi.fn() };

    // Empty tool uses → runCriticChecks returns null → no injection
    await applyCritic(state, client, config, [], [], 'agent text', callbacks, new AbortController().signal);
    expect((state as { messages: unknown[] }).messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// gatherReadEvidence + applyAnalysisCritic (V2)
// ---------------------------------------------------------------------------

function reviewMsgs(extra: unknown[] = []) {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Review the architecture of this project.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/loop.ts' } }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function runAgentLoop() {}' }],
    },
    ...extra,
  ] as never[];
}

describe('gatherReadEvidence', () => {
  it('assembles labeled excerpts from read tool results', () => {
    const evidence = gatherReadEvidence(reviewMsgs());
    expect(evidence).toContain('read_file(src/loop.ts)');
    expect(evidence).toContain('export function runAgentLoop');
  });

  it('skips errored tool results', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'x.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ENOENT', is_error: true }] },
    ] as never[];
    expect(gatherReadEvidence(msgs)).toBe('');
  });

  it('returns empty when no read tools were called', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'x.ts' } }] },
    ] as never[];
    expect(gatherReadEvidence(msgs)).toBe('');
  });
});

describe('applyAnalysisCritic', () => {
  const callbacks = { onText: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onDone: vi.fn() };
  const client = {
    routeForDispatch: vi.fn().mockReturnValue(null),
    completeWithOverrides: vi.fn().mockResolvedValue('{"findings":[]}'),
  } as never;
  function state(messages: never[]) {
    return { messages, logger: undefined, analysisCriticFired: false } as never;
  }
  beforeEach(() => {
    vi.mocked(parseCriticResponse).mockReturnValue({ malformed: false, explicitlyClean: false, findings: [] });
    callbacks.onText.mockClear();
  });

  it('is a no-op when criticEnabled is false', async () => {
    const s = state(reviewMsgs());
    await applyAnalysisCritic(
      s,
      client,
      { criticEnabled: false } as never,
      'The loop is solid.',
      callbacks,
      new AbortController().signal,
    );
    expect((s as { messages: unknown[] }).messages.length).toBe(3);
  });

  it('is a no-op when the request is not an analysis', async () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'Add a function to src/a.ts' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'code' }] },
    ] as never[];
    const s = state(msgs);
    await applyAnalysisCritic(
      s,
      client,
      { criticEnabled: true } as never,
      'done',
      callbacks,
      new AbortController().signal,
    );
    expect((s as { analysisCriticFired: boolean }).analysisCriticFired).toBe(false);
  });

  it('is a no-op when there is no read evidence', async () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'Review the architecture of this project.' }] },
    ] as never[];
    const s = state(msgs);
    await applyAnalysisCritic(
      s,
      client,
      { criticEnabled: true } as never,
      'A review.',
      callbacks,
      new AbortController().signal,
    );
    expect((s as { analysisCriticFired: boolean }).analysisCriticFired).toBe(false);
  });

  it('annotates findings without blocking (advisory) and fires at most once', async () => {
    vi.mocked(parseCriticResponse).mockReturnValue({
      malformed: false,
      explicitlyClean: false,
      findings: [{ severity: 'high', title: 'mislabeled', evidence: 'loop.ts is the loop, not a scheduler' }],
    });
    vi.mocked(splitBySeverity).mockReturnValue({
      high: [{ severity: 'high', title: 'mislabeled', evidence: 'x' }],
      low: [],
    });
    const s = state(reviewMsgs());
    const config = { criticEnabled: true, criticBlockOnHighSeverity: true } as never;
    await applyAnalysisCritic(
      s,
      client,
      config,
      'scheduler.ts is the core loop.',
      callbacks,
      new AbortController().signal,
    );
    // Advisory: surfaced via onText, NOT injected as a blocking reprompt — even
    // with criticBlockOnHighSeverity true. The review message count is unchanged.
    expect((s as { messages: unknown[] }).messages.length).toBe(3);
    expect(callbacks.onText).toHaveBeenCalledWith('formatted findings');
    expect((s as { analysisCriticFired: boolean }).analysisCriticFired).toBe(true);

    // Second call is a no-op (already fired) — no extra annotation.
    callbacks.onText.mockClear();
    await applyAnalysisCritic(s, client, config, 'again', callbacks, new AbortController().signal);
    expect(callbacks.onText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runCriticChecks
// ---------------------------------------------------------------------------

describe('runCriticChecks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCriticStats();
  });

  const makeCallbacks = () => ({
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  });

  it('returns null when there are no edit or test_failure tool uses', async () => {
    const result = await runCriticChecks({
      client: {} as never,
      config: {} as never,
      pendingToolUses: [{ type: 'tool_use', id: 'x', name: 'read_file', input: { path: 'a.ts' } }],
      toolResults: [{ type: 'tool_result', tool_use_id: 'x', content: 'file contents' }],
      changelog: undefined,
      fullText: 'reading the file',
      callbacks: makeCallbacks(),
      logger: undefined,
      signal: new AbortController().signal,
      criticInjectionsByFile: new Map(),
      maxPerFile: 3,
    });
    expect(result).toBeNull();
  });

  it('returns null when tool result has is_error=true (skips the trigger)', async () => {
    const result = await runCriticChecks({
      client: {} as never,
      config: {} as never,
      pendingToolUses: [{ type: 'tool_use', id: 'y', name: 'write_file', input: { path: 'b.ts' } }],
      toolResults: [{ type: 'tool_result', tool_use_id: 'y', content: 'error', is_error: true }],
      changelog: undefined,
      fullText: '',
      callbacks: makeCallbacks(),
      logger: undefined,
      signal: new AbortController().signal,
      criticInjectionsByFile: new Map(),
      maxPerFile: 3,
    });
    expect(result).toBeNull();
  });

  it('returns null when buildCriticDiff returns null (readFile throws)', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('file disappeared'));

    const result = await runCriticChecks({
      client: {} as never,
      config: {} as never,
      pendingToolUses: [{ type: 'tool_use', id: 'z', name: 'write_file', input: { path: 'src/foo.ts' } }],
      toolResults: [{ type: 'tool_result', tool_use_id: 'z', content: 'written' }],
      changelog: undefined,
      fullText: 'writing the file',
      callbacks: makeCallbacks(),
      logger: undefined,
      signal: new AbortController().signal,
      criticInjectionsByFile: new Map(),
      maxPerFile: 3,
    });
    expect(result).toBeNull();
  });

  it('returns null when signal is aborted before the critic fires', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from('const x = 1;') as never);
    const ac = new AbortController();
    ac.abort();

    const result = await runCriticChecks({
      client: {} as never,
      config: {} as never,
      pendingToolUses: [{ type: 'tool_use', id: 'w', name: 'edit_file', input: { path: 'src/x.ts' } }],
      toolResults: [{ type: 'tool_result', tool_use_id: 'w', content: 'edited' }],
      changelog: undefined,
      fullText: 'fixing the logic in the function',
      callbacks: makeCallbacks(),
      logger: undefined,
      signal: ac.signal,
      criticInjectionsByFile: new Map(),
      maxPerFile: 3,
    });
    expect(result).toBeNull();
  });

  it('returns null when client.completeWithOverrides returns clean response (no findings)', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from('const y = 2;') as never);
    const mockClient = {
      routeForDispatch: vi.fn().mockReturnValue(null),
      completeWithOverrides: vi.fn().mockResolvedValue('The code looks fine.'),
    };

    const result = await runCriticChecks({
      client: mockClient as never,
      config: { criticModel: undefined, criticBlockOnHighSeverity: false } as never,
      pendingToolUses: [{ type: 'tool_use', id: 'v', name: 'write_file', input: { path: 'src/clean.ts' } }],
      toolResults: [{ type: 'tool_result', tool_use_id: 'v', content: 'written' }],
      changelog: undefined,
      fullText: 'added clean code',
      callbacks: makeCallbacks(),
      logger: undefined,
      signal: new AbortController().signal,
      criticInjectionsByFile: new Map(),
      maxPerFile: 3,
    });
    // parseCriticResponse mock returns findings: [] → return null
    expect(result).toBeNull();
  });

  it('returns non-null injection when critic finds high-severity issues', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from('const z = 3;') as never);
    const mockClient = {
      routeForDispatch: vi.fn().mockReturnValue(null),
      completeWithOverrides: vi.fn().mockResolvedValue('HIGH: SQL injection on line 5'),
    };
    const highFinding = { severity: 'high' as const, title: 'SQL injection', evidence: 'Unsafe query on line 5' };
    vi.mocked(parseCriticResponse).mockReturnValueOnce({
      malformed: false,
      explicitlyClean: false,
      findings: [highFinding],
    });
    vi.mocked(splitBySeverity).mockReturnValueOnce({ high: [highFinding], low: [] });

    const result = await runCriticChecks({
      client: mockClient as never,
      config: { criticModel: undefined, criticBlockOnHighSeverity: true } as never,
      pendingToolUses: [{ type: 'tool_use', id: 't', name: 'write_file', input: { path: 'src/bad.ts' } }],
      toolResults: [{ type: 'tool_result', tool_use_id: 't', content: 'written' }],
      changelog: undefined,
      fullText: 'adding vulnerable code',
      callbacks: makeCallbacks(),
      logger: undefined,
      signal: new AbortController().signal,
      criticInjectionsByFile: new Map(),
      maxPerFile: 3,
    });
    expect(result).not.toBeNull();
  });

  it('skips edit triggers that have reached the per-file cap', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from('code') as never);
    const injByFile = new Map([['src/capped.ts', 3]]);

    const result = await runCriticChecks({
      client: {} as never,
      config: {} as never,
      pendingToolUses: [{ type: 'tool_use', id: 'u', name: 'write_file', input: { path: 'src/capped.ts' } }],
      toolResults: [{ type: 'tool_result', tool_use_id: 'u', content: 'written' }],
      changelog: undefined,
      fullText: 'editing a capped file',
      callbacks: makeCallbacks(),
      logger: undefined,
      signal: new AbortController().signal,
      criticInjectionsByFile: injByFile,
      maxPerFile: 2,
    });
    expect(result).toBeNull();
  });
});
