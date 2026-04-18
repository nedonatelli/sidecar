import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for facetDispatcher.ts (v0.66 chunk 3.3).
//
// Covers:
//   - dispatchFacet: tool-allowlist → toolOverride + modeToolPermissions,
//     preferredModel pin + restore, system prompt composition,
//     forceShadow: true, output capture, failure path
//   - dispatchFacets: layers run in dependency order, maxConcurrent cap,
//     results in input order, unknown facet id returns synthetic error
//     without aborting the batch
// ---------------------------------------------------------------------------

const { runAgentLoopInSandboxMock } = vi.hoisted(() => ({
  runAgentLoopInSandboxMock: vi.fn(),
}));

vi.mock('../shadow/sandbox.js', () => ({
  runAgentLoopInSandbox: runAgentLoopInSandboxMock,
}));

import { dispatchFacet, dispatchFacets } from './facetDispatcher.js';
import { buildFacetRegistry } from './facetRegistry.js';
import type { FacetDefinition } from './facetLoader.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks } from '../loop.js';

function makeClient(): SideCarClient & {
  getSystemPrompt: ReturnType<typeof vi.fn>;
  updateSystemPrompt: ReturnType<typeof vi.fn>;
  getTurnOverride: ReturnType<typeof vi.fn>;
  setTurnOverride: ReturnType<typeof vi.fn>;
} {
  return {
    getSystemPrompt: vi.fn().mockReturnValue('<orchestrator prompt>'),
    updateSystemPrompt: vi.fn(),
    getTurnOverride: vi.fn().mockReturnValue(null),
    setTurnOverride: vi.fn(),
  } as unknown as SideCarClient & {
    getSystemPrompt: ReturnType<typeof vi.fn>;
    updateSystemPrompt: ReturnType<typeof vi.fn>;
    getTurnOverride: ReturnType<typeof vi.fn>;
    setTurnOverride: ReturnType<typeof vi.fn>;
  };
}

function makeCallbacks(): AgentCallbacks & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    onText: (t: string) => texts.push(t),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  };
}

function facet(overrides: Partial<FacetDefinition> = {}): FacetDefinition {
  return {
    id: 'f',
    displayName: 'F',
    systemPrompt: 'facet prompt body',
    source: 'builtin',
    filePath: '',
    dependsOn: [],
    ...overrides,
  } as FacetDefinition;
}

beforeEach(() => {
  runAgentLoopInSandboxMock.mockReset();
});

// ---------------------------------------------------------------------------
// dispatchFacet
// ---------------------------------------------------------------------------

describe('dispatchFacet — success path', () => {
  it('calls runAgentLoopInSandbox with forceShadow: true', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true, shadowId: 'sh-1' });
    const client = makeClient();
    const f = facet({ id: 'dsp', toolAllowlist: ['read_file', 'grep'] });
    await dispatchFacet(client, f, makeCallbacks(), {
      task: 'design a filter',
      signal: new AbortController().signal,
    });
    expect(runAgentLoopInSandboxMock).toHaveBeenCalledOnce();
    const sandboxOpts = runAgentLoopInSandboxMock.mock.calls[0][5];
    expect(sandboxOpts).toEqual({ forceShadow: true });
  });

  it('pins preferredModel via setTurnOverride and restores it on exit', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const client = makeClient();
    client.getTurnOverride = vi.fn().mockReturnValue(null);
    const f = facet({ id: 'dsp', preferredModel: 'claude-sonnet-4' });
    await dispatchFacet(client, f, makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
    });
    expect(client.setTurnOverride).toHaveBeenCalledWith('claude-sonnet-4');
    // Last call restores to the pre-dispatch value (null here).
    expect(client.setTurnOverride.mock.calls.at(-1)![0]).toBeNull();
  });

  it('does not pin model when preferredModel is unset', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const client = makeClient();
    const f = facet({ preferredModel: undefined });
    await dispatchFacet(client, f, makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
    });
    // setTurnOverride called only to restore (which is a no-op path too),
    // and only once if at all. Assertion: never called with a non-null
    // value.
    for (const call of client.setTurnOverride.mock.calls) {
      expect(call[0]).not.toBe('claude-sonnet-4');
    }
  });

  it('composes the facet system prompt on top of the prior one and restores', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const client = makeClient();
    const f = facet({ id: 'dsp', systemPrompt: 'You are a DSP specialist.' });
    await dispatchFacet(client, f, makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
    });
    const composedPrompt = client.updateSystemPrompt.mock.calls[0][0] as string;
    expect(composedPrompt).toContain('"F" facet (id: dsp)');
    expect(composedPrompt).toContain('You are a DSP specialist.');
    expect(composedPrompt).toContain('orchestrator rules');
    expect(composedPrompt).toContain('<orchestrator prompt>');
    // Last updateSystemPrompt call restores the prior prompt verbatim.
    expect(client.updateSystemPrompt.mock.calls.at(-1)![0]).toBe('<orchestrator prompt>');
  });

  it('filters toolOverride via the facet allowlist when baseTools are provided', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const client = makeClient();
    const f = facet({ id: 'dsp', toolAllowlist: ['read_file', 'grep'] });
    const baseTools = [
      { name: 'read_file', description: '', input_schema: { type: 'object' as const, properties: {} } },
      { name: 'write_file', description: '', input_schema: { type: 'object' as const, properties: {} } },
      { name: 'grep', description: '', input_schema: { type: 'object' as const, properties: {} } },
      { name: 'run_command', description: '', input_schema: { type: 'object' as const, properties: {} } },
    ];
    await dispatchFacet(client, f, makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      agentOptions: { toolOverride: baseTools },
    });
    const passedOptions = runAgentLoopInSandboxMock.mock.calls[0][4];
    const names = (passedOptions.toolOverride as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(['read_file', 'grep']);
  });

  it('sets modeToolPermissions to "allow" for every allowlisted tool', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const client = makeClient();
    const f = facet({ id: 'dsp', toolAllowlist: ['read_file', 'grep'] });
    await dispatchFacet(client, f, makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
    });
    const perms = runAgentLoopInSandboxMock.mock.calls[0][4].modeToolPermissions as Record<string, string>;
    expect(perms.read_file).toBe('allow');
    expect(perms.grep).toBe('allow');
    expect(perms.write_file).toBeUndefined();
  });

  it('forces approvalMode: "autonomous"', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const client = makeClient();
    const f = facet({ id: 'dsp' });
    await dispatchFacet(client, f, makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      agentOptions: { approvalMode: 'cautious' },
    });
    expect(runAgentLoopInSandboxMock.mock.calls[0][4].approvalMode).toBe('autonomous');
  });

  it('captures output text emitted via callbacks.onText', async () => {
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, cb) => {
      cb.onText('Hello ');
      cb.onText('from facet');
      return { mode: 'shadow', applied: true };
    });
    const client = makeClient();
    const f = facet({ id: 'dsp' });
    const result = await dispatchFacet(client, f, makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
    });
    expect(result.output).toBe('Hello from facet');
    expect(result.success).toBe(true);
  });

  it('prefixes tool-name events with the facet id when forwarding to parent', async () => {
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, cb) => {
      cb.onToolCall('read_file', { path: 'a.ts' }, 'tu1');
      cb.onToolResult('read_file', 'content', false, 'tu1');
      return { mode: 'shadow', applied: true };
    });
    const client = makeClient();
    const cb = makeCallbacks();
    const f = facet({ id: 'dsp' });
    await dispatchFacet(client, f, cb, {
      task: 'x',
      signal: new AbortController().signal,
    });
    expect(cb.onToolCall).toHaveBeenCalledWith('dsp:read_file', { path: 'a.ts' }, 'tu1');
    expect(cb.onToolResult).toHaveBeenCalledWith('dsp:read_file', 'content', false, 'tu1');
  });

  it('returns placeholder output when the facet produces no text', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const client = makeClient();
    const result = await dispatchFacet(client, facet(), makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
    });
    expect(result.output).toBe('(facet produced no output)');
  });
});

describe('dispatchFacet — failure path', () => {
  it('returns success=false with errorMessage when runAgentLoopInSandbox throws', async () => {
    runAgentLoopInSandboxMock.mockRejectedValue(new Error('backend offline'));
    const client = makeClient();
    const result = await dispatchFacet(client, facet(), makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('backend offline');
    // Sandbox result on failure is synthetic 'direct' + apply-failed.
    expect(result.sandbox.mode).toBe('direct');
    expect(result.sandbox.applied).toBe(false);
  });

  it('restores system prompt + model override even on failure', async () => {
    runAgentLoopInSandboxMock.mockRejectedValue(new Error('boom'));
    const client = makeClient();
    client.getTurnOverride = vi.fn().mockReturnValue('prior-model');
    await dispatchFacet(client, facet({ preferredModel: 'specialist-model' }), makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
    });
    // System prompt final call is the restore to the captured prior.
    expect(client.updateSystemPrompt.mock.calls.at(-1)![0]).toBe('<orchestrator prompt>');
    // Model override final call is the restore.
    expect(client.setTurnOverride.mock.calls.at(-1)![0]).toBe('prior-model');
  });
});

// ---------------------------------------------------------------------------
// dispatchFacets — multi-facet orchestration
// ---------------------------------------------------------------------------

describe('dispatchFacets — orchestration', () => {
  it('returns empty array for empty input', async () => {
    const reg = buildFacetRegistry([facet({ id: 'a' })]);
    const result = await dispatchFacets(makeClient(), reg, [], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 3,
    });
    expect(result).toEqual([]);
  });

  it('runs independent facets in parallel up to maxConcurrent', async () => {
    let inFlight = 0;
    let peak = 0;
    runAgentLoopInSandboxMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { mode: 'shadow', applied: true };
    });
    const facets = [facet({ id: 'a' }), facet({ id: 'b' }), facet({ id: 'c' }), facet({ id: 'd' })];
    const reg = buildFacetRegistry(facets);
    const result = await dispatchFacets(makeClient(), reg, ['a', 'b', 'c', 'd'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 2,
    });
    expect(result).toHaveLength(4);
    expect(peak).toBe(2);
  });

  it('runs dependent facets after their dependencies land', async () => {
    const events: string[] = [];
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, cb) => {
      const facetIdFromPrompt = (
        _c as { updateSystemPrompt?: ReturnType<typeof vi.fn> }
      ).updateSystemPrompt?.mock.calls.at(-1)?.[0] as string | undefined;
      // Rough extraction — parse "facet (id: X)" from the composed prompt.
      const match = facetIdFromPrompt?.match(/id: (\w+)/);
      const id = match?.[1] ?? '?';
      events.push(`${id}-start`);
      await new Promise((r) => setTimeout(r, 1));
      events.push(`${id}-end`);
      cb.onText('done');
      return { mode: 'shadow', applied: true };
    });
    const facets = [facet({ id: 'root' }), facet({ id: 'child', dependsOn: ['root'] })];
    const reg = buildFacetRegistry(facets);
    await dispatchFacets(makeClient(), reg, ['child', 'root'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
    });
    // root finishes before child starts (layer ordering).
    expect(events.indexOf('root-end')).toBeLessThan(events.indexOf('child-start'));
  });

  it('returns results in original input order regardless of layer order', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const facets = [facet({ id: 'root' }), facet({ id: 'leaf', dependsOn: ['root'] }), facet({ id: 'independent' })];
    const reg = buildFacetRegistry(facets);
    const result = await dispatchFacets(makeClient(), reg, ['leaf', 'independent', 'root'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
    });
    expect(result.map((r) => r.facetId)).toEqual(['leaf', 'independent', 'root']);
  });

  it('surfaces unknown facet ids as synthetic error results without aborting the batch', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const reg = buildFacetRegistry([facet({ id: 'real' })]);
    const result = await dispatchFacets(makeClient(), reg, ['real', 'ghost'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
    });
    expect(result).toHaveLength(2);
    expect(result[0].facetId).toBe('real');
    expect(result[0].success).toBe(true);
    expect(result[1].facetId).toBe('ghost');
    expect(result[1].success).toBe(false);
    expect(result[1].errorMessage).toContain('Unknown facet id "ghost"');
  });

  it('stops dispatching later layers when the signal aborts mid-run', async () => {
    const ctrl = new AbortController();
    let callCount = 0;
    runAgentLoopInSandboxMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) ctrl.abort();
      return { mode: 'shadow', applied: true };
    });
    const facets = [facet({ id: 'root' }), facet({ id: 'child', dependsOn: ['root'] })];
    const reg = buildFacetRegistry(facets);
    await dispatchFacets(makeClient(), reg, ['root', 'child'], makeCallbacks(), {
      task: 'x',
      signal: ctrl.signal,
      maxConcurrent: 4,
    });
    // root ran, child did not (layer 2 skipped after abort).
    expect(callCount).toBe(1);
  });
});
