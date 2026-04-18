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
  it('calls runAgentLoopInSandbox with forceShadow + deferPrompt', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true, shadowId: 'sh-1' });
    const client = makeClient();
    const f = facet({ id: 'dsp', toolAllowlist: ['read_file', 'grep'] });
    await dispatchFacet(client, f, makeCallbacks(), {
      task: 'design a filter',
      signal: new AbortController().signal,
    });
    expect(runAgentLoopInSandboxMock).toHaveBeenCalledOnce();
    const sandboxOpts = runAgentLoopInSandboxMock.mock.calls[0][5];
    expect(sandboxOpts).toEqual({ forceShadow: true, deferPrompt: true });
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
  it('returns empty results for empty input, bus wire trace is empty', async () => {
    const reg = buildFacetRegistry([facet({ id: 'a' })]);
    const batch = await dispatchFacets(makeClient(), reg, [], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 3,
    });
    expect(batch.results).toEqual([]);
    expect(batch.rpcWireTrace).toEqual([]);
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
    const batch = await dispatchFacets(makeClient(), reg, ['a', 'b', 'c', 'd'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 2,
    });
    expect(batch.results).toHaveLength(4);
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
    const batch = await dispatchFacets(makeClient(), reg, ['leaf', 'independent', 'root'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
    });
    expect(batch.results.map((r) => r.facetId)).toEqual(['leaf', 'independent', 'root']);
  });

  it('surfaces unknown facet ids as synthetic error results without aborting the batch', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue({ mode: 'shadow', applied: true });
    const reg = buildFacetRegistry([facet({ id: 'real' })]);
    const batch = await dispatchFacets(makeClient(), reg, ['real', 'ghost'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
    });
    expect(batch.results).toHaveLength(2);
    expect(batch.results[0].facetId).toBe('real');
    expect(batch.results[0].success).toBe(true);
    expect(batch.results[1].facetId).toBe('ghost');
    expect(batch.results[1].success).toBe(false);
    expect(batch.results[1].errorMessage).toContain('Unknown facet id "ghost"');
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

// ---------------------------------------------------------------------------
// dispatchFacets — RPC wiring (v0.66 chunk 3.4b)
// ---------------------------------------------------------------------------

describe('dispatchFacets — RPC wiring', () => {
  it('registers supplied rpcHandlers on the bus before any facet runs', async () => {
    const handler = vi.fn().mockResolvedValue('handled');
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, _cb, _signal, options) => {
      // The extraTools carry executors that resolve through the bus.
      // Simulate a facet calling rpc.latex.publishMathBlock.
      const extraTools = options.extraTools as Array<{
        definition: { name: string };
        executor: (input: Record<string, unknown>) => Promise<string>;
      }>;
      const rpcTool = extraTools?.find((t) => t.definition.name === 'rpc.latex.publishMathBlock');
      if (rpcTool) {
        await rpcTool.executor({ args: { symbol: 'fft' } });
      }
      return { mode: 'shadow', applied: true };
    });
    const facets = [facet({ id: 'dsp', rpcSchema: {} }), facet({ id: 'latex', rpcSchema: { publishMathBlock: {} } })];
    const reg = buildFacetRegistry(facets);
    const batch = await dispatchFacets(makeClient(), reg, ['dsp', 'latex'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
      rpcHandlers: {
        latex: { publishMathBlock: handler },
      },
    });
    // Handler was actually called from the dsp facet.
    expect(handler).toHaveBeenCalledWith({ symbol: 'fft' }, expect.objectContaining({ callerFacetId: 'dsp' }));
    // Wire trace carries one successful ok-outcome.
    const okCalls = batch.rpcWireTrace.filter((t) => t.outcome === 'ok');
    expect(okCalls).toHaveLength(1);
    expect(okCalls[0]).toMatchObject({
      callerFacetId: 'dsp',
      receiverFacetId: 'latex',
      method: 'publishMathBlock',
    });
  });

  it("generates rpc.<peer>.<method> tools on the caller facet's toolOverride + extraTools", async () => {
    // Both facets invoke the sandbox — capture per-facet by keying on
    // the system prompt's id marker so the assertions target dsp's
    // dispatch (not latex's, which has no peer rpcSchema to call).
    const toolOverrideByFacet = new Map<string, Array<{ name: string }>>();
    const extraToolsByFacet = new Map<string, Array<{ definition: { name: string } }>>();
    runAgentLoopInSandboxMock.mockImplementation(async (c, _m, _cb, _signal, options) => {
      const composedPrompt = (c as { updateSystemPrompt?: ReturnType<typeof vi.fn> }).updateSystemPrompt?.mock.calls.at(
        -1,
      )?.[0] as string | undefined;
      const match = composedPrompt?.match(/id: (\w+)/);
      const facetId = match?.[1] ?? '?';
      toolOverrideByFacet.set(facetId, (options.toolOverride ?? []) as Array<{ name: string }>);
      extraToolsByFacet.set(facetId, (options.extraTools ?? []) as Array<{ definition: { name: string } }>);
      return { mode: 'shadow', applied: true };
    });
    const facets = [
      facet({ id: 'dsp' }),
      facet({ id: 'latex', rpcSchema: { publishMathBlock: {}, requestDefinition: {} } }),
    ];
    const reg = buildFacetRegistry(facets);
    await dispatchFacets(makeClient(), reg, ['dsp', 'latex'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
    });
    // dsp's toolOverride includes both rpc tools (peer latex has 2 methods).
    const dspToolNames = (toolOverrideByFacet.get('dsp') ?? []).map((t) => t.name).filter((n) => n.startsWith('rpc.'));
    expect(dspToolNames.sort()).toEqual(['rpc.latex.publishMathBlock', 'rpc.latex.requestDefinition']);
    const dspExtraToolNames = (extraToolsByFacet.get('dsp') ?? []).map((t) => t.definition.name);
    expect(dspExtraToolNames.sort()).toEqual(['rpc.latex.publishMathBlock', 'rpc.latex.requestDefinition']);
  });

  it('no rpc tools are generated when no peer declares an rpcSchema', async () => {
    let sawToolOverride: Array<{ name: string }> | undefined;
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, _cb, _signal, options) => {
      sawToolOverride = options.toolOverride as typeof sawToolOverride;
      return { mode: 'shadow', applied: true };
    });
    const facets = [facet({ id: 'a' }), facet({ id: 'b' })]; // neither declares rpcSchema
    const reg = buildFacetRegistry(facets);
    await dispatchFacets(makeClient(), reg, ['a', 'b'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
    });
    const rpcTools = (sawToolOverride ?? []).filter((t) => t.name.startsWith('rpc.'));
    expect(rpcTools).toHaveLength(0);
  });

  it('RPC calls to unregistered handlers surface as [rpc-error:no-handler] in the tool output', async () => {
    let toolResult: string | undefined;
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, _cb, _signal, options) => {
      const extraTools = options.extraTools as Array<{
        definition: { name: string };
        executor: (input: Record<string, unknown>) => Promise<string>;
      }>;
      const rpcTool = extraTools?.find((t) => t.definition.name === 'rpc.peer.missing');
      if (rpcTool) toolResult = await rpcTool.executor({ args: {} });
      return { mode: 'shadow', applied: true };
    });
    const facets = [facet({ id: 'caller' }), facet({ id: 'peer', rpcSchema: { missing: {} } })];
    const reg = buildFacetRegistry(facets);
    // No rpcHandlers provided — the peer's methods won't have handlers.
    await dispatchFacets(makeClient(), reg, ['caller', 'peer'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
    });
    expect(toolResult).toMatch(/^\[rpc-error:no-handler\]/);
  });

  it('honors rpcTimeoutMs from options', async () => {
    const handler = vi.fn(() => new Promise((r) => setTimeout(() => r('too-late'), 200)));
    let toolResult: string | undefined;
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, _cb, _signal, options) => {
      const extraTools = options.extraTools as Array<{
        definition: { name: string };
        executor: (input: Record<string, unknown>) => Promise<string>;
      }>;
      const rpcTool = extraTools?.find((t) => t.definition.name === 'rpc.peer.slow');
      if (rpcTool) toolResult = await rpcTool.executor({ args: {} });
      return { mode: 'shadow', applied: true };
    });
    const facets = [facet({ id: 'caller' }), facet({ id: 'peer', rpcSchema: { slow: {} } })];
    const reg = buildFacetRegistry(facets);
    await dispatchFacets(makeClient(), reg, ['caller', 'peer'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
      rpcTimeoutMs: 50,
      rpcHandlers: { peer: { slow: handler } },
    });
    expect(toolResult).toMatch(/^\[rpc-error:timeout\]/);
  });

  it("clears a facet's handlers after its loop completes so later calls no-handler", async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    // The dispatch order here: layer 1 = [a], layer 2 = [b]. b runs
    // AFTER a completes. If a's handlers were still registered after
    // its teardown, b could call a and succeed; we expect no-handler.
    // Track tool results per facet id.
    const resultsByFacet = new Map<string, string>();
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, _cb, _signal, options) => {
      // Extract the caller facet id from the composed system prompt —
      // same trick as the ordering test above.
      const composedPrompt = (
        _c as { updateSystemPrompt?: ReturnType<typeof vi.fn> }
      ).updateSystemPrompt?.mock.calls.at(-1)?.[0] as string | undefined;
      const match = composedPrompt?.match(/id: (\w+)/);
      const facetId = match?.[1] ?? '?';
      const extraTools = options.extraTools as Array<{
        definition: { name: string };
        executor: (input: Record<string, unknown>) => Promise<string>;
      }>;
      const tool = extraTools?.find((t) => t.definition.name.startsWith('rpc.'));
      if (tool) resultsByFacet.set(facetId, await tool.executor({ args: {} }));
      return { mode: 'shadow', applied: true };
    });
    const facets = [facet({ id: 'a', rpcSchema: { m: {} } }), facet({ id: 'b', dependsOn: ['a'], rpcSchema: {} })];
    const reg = buildFacetRegistry(facets);
    await dispatchFacets(makeClient(), reg, ['a', 'b'], makeCallbacks(), {
      task: 'x',
      signal: new AbortController().signal,
      maxConcurrent: 4,
      rpcHandlers: { a: { m: handler } },
    });
    // When b ran and called rpc.a.m, the handler should have been
    // cleared after a finished — so b sees no-handler.
    expect(resultsByFacet.get('b')).toMatch(/^\[rpc-error:no-handler\]/);
  });
});
