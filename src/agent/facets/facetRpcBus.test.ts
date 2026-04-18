import { describe, it, expect, vi } from 'vitest';
import { FacetRpcBus, generateRpcTools, formatWireTrace } from './facetRpcBus.js';
import type { FacetDefinition } from './facetLoader.js';

// ---------------------------------------------------------------------------
// Tests for facetRpcBus.ts (v0.66 chunk 3.4a).
//
// Covers:
//   - FacetRpcBus.call routing (happy path, no-handler, handler throw,
//     timeout)
//   - Wire trace logging (every outcome recorded with timing)
//   - clearFacetHandlers scope
//   - generateRpcTools: one tool per receiverFacetId × method, excludes
//     caller's own methods, wires through the bus
//   - formatWireTrace rendering
// ---------------------------------------------------------------------------

function facet(overrides: Partial<FacetDefinition> = {}): FacetDefinition {
  return {
    id: 'f',
    displayName: 'F',
    systemPrompt: 'body',
    source: 'builtin',
    filePath: '',
    dependsOn: [],
    ...overrides,
  } as FacetDefinition;
}

// ---------------------------------------------------------------------------
// FacetRpcBus
// ---------------------------------------------------------------------------

describe('FacetRpcBus — call routing', () => {
  it('routes a call to a registered handler and returns its value', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 1000 });
    bus.registerHandler('latex-writer', 'publishMathBlock', async (args) => ({
      ack: true,
      symbol: args.symbol,
    }));
    const outcome = await bus.call('signal-processing', 'latex-writer', 'publishMathBlock', {
      symbol: 'fft',
      latex: 'X_k=...',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual({ ack: true, symbol: 'fft' });
    }
  });

  it('supports synchronous handler return values (Promise.resolve wraps them)', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 1000 });
    bus.registerHandler('x', 'echo', (args) => args);
    const outcome = await bus.call('caller', 'x', 'echo', { hi: 'there' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual({ hi: 'there' });
    }
  });

  it('passes the RpcCallContext to the handler (caller, receiver, method, startedAt)', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 1000 });
    const handler = vi.fn().mockResolvedValue('ok');
    bus.registerHandler('b', 'hello', handler);
    await bus.call('a', 'b', 'hello', { x: 1 });
    const ctx = handler.mock.calls[0][1];
    expect(ctx).toMatchObject({ callerFacetId: 'a', receiverFacetId: 'b', method: 'hello' });
    expect(typeof ctx.startedAt).toBe('number');
  });
});

describe('FacetRpcBus — error outcomes', () => {
  it('returns no-handler error when the target method is not registered', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 1000 });
    const outcome = await bus.call('a', 'missing', 'method', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorKind).toBe('no-handler');
      expect(outcome.message).toContain('No facet handler');
    }
  });

  it('returns handler-threw when the handler rejects with an Error', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 1000 });
    bus.registerHandler('b', 'fail', async () => {
      throw new Error('boom');
    });
    const outcome = await bus.call('a', 'b', 'fail', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorKind).toBe('handler-threw');
      expect(outcome.message).toContain('boom');
    }
  });

  it('coerces non-Error handler throws to strings', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 1000 });
    bus.registerHandler('b', 'fail', () => {
      // Non-Error throw — a real handler might throw a string or
      // custom payload and the bus must coerce, not explode.
      // eslint-disable-next-line no-throw-literal
      throw 'string rejection';
    });
    const outcome = await bus.call('a', 'b', 'fail', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain('string rejection');
    }
  });

  it('returns timeout when the handler exceeds timeoutMs', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 50 });
    bus.registerHandler('b', 'slow', () => new Promise((r) => setTimeout(() => r('done'), 200)));
    const outcome = await bus.call('a', 'b', 'slow', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorKind).toBe('timeout');
      expect(outcome.message).toMatch(/50ms/);
    }
  });

  it('never rejects — every outcome resolves to a typed shape', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 50 });
    bus.registerHandler('b', 'fail', () => {
      throw new Error('x');
    });
    // If bus.call ever rejected, this would surface as an unhandled rejection.
    await expect(bus.call('a', 'b', 'fail', {})).resolves.toBeDefined();
    await expect(bus.call('a', 'nobody', 'missing', {})).resolves.toBeDefined();
  });
});

describe('FacetRpcBus — wire trace', () => {
  it('records every call outcome (ok, no-handler, handler-threw, timeout)', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 50 });
    bus.registerHandler('b', 'ok', async () => 'yay');
    bus.registerHandler('b', 'fail', () => {
      throw new Error('x');
    });
    bus.registerHandler('b', 'slow', () => new Promise((r) => setTimeout(() => r('late'), 200)));
    await bus.call('a', 'b', 'ok', { x: 1 });
    await bus.call('a', 'b', 'fail', {});
    await bus.call('a', 'b', 'slow', {});
    await bus.call('a', 'missing', 'method', {});
    const trace = bus.getWireTrace();
    expect(trace.map((t) => t.outcome).sort()).toEqual(['handler-threw', 'no-handler', 'ok', 'timeout']);
  });

  it('records the args verbatim in each trace entry', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 1000 });
    bus.registerHandler('b', 'm', async () => 'ok');
    await bus.call('a', 'b', 'm', { sample: 'value', nested: { k: 'v' } });
    const trace = bus.getWireTrace();
    expect(trace[0].args).toEqual({ sample: 'value', nested: { k: 'v' } });
  });

  it('records startedAt <= finishedAt for every entry', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    bus.registerHandler('b', 'm', async () => 'x');
    await bus.call('a', 'b', 'm', {});
    const trace = bus.getWireTrace();
    expect(trace[0].startedAt).toBeLessThanOrEqual(trace[0].finishedAt);
  });

  it('getWireTrace returns a copy — callers can retain safely', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    bus.registerHandler('b', 'm', async () => 'x');
    await bus.call('a', 'b', 'm', {});
    const first = bus.getWireTrace() as unknown as { push: (x: unknown) => number };
    first.push({ fake: 'entry' });
    expect(bus.getWireTrace()).toHaveLength(1);
  });
});

describe('FacetRpcBus — clearFacetHandlers', () => {
  it('removes every handler for a given receiver facet id', () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    bus.registerHandler('a', 'm1', async () => 1);
    bus.registerHandler('a', 'm2', async () => 2);
    bus.registerHandler('b', 'm1', async () => 3);
    expect(bus.handlerCount()).toBe(3);
    bus.clearFacetHandlers('a');
    expect(bus.handlerCount()).toBe(1);
  });

  it('returns no-handler for cleared methods on the next call', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    bus.registerHandler('a', 'm', async () => 'gone');
    bus.clearFacetHandlers('a');
    const out = await bus.call('caller', 'a', 'm', {});
    expect(out.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateRpcTools
// ---------------------------------------------------------------------------

describe('generateRpcTools', () => {
  it('generates one tool per peer method, named rpc.<facetId>.<method>', () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    const peer = facet({
      id: 'latex-writer',
      rpcSchema: {
        publishMathBlock: { params: { symbol: 'string', latex: 'string' } },
        requestDefinition: {},
      },
    });
    const tools = generateRpcTools('signal-processing', [peer], bus);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.definition.name).sort()).toEqual([
      'rpc.latex-writer.publishMathBlock',
      'rpc.latex-writer.requestDefinition',
    ]);
  });

  it('excludes the caller facet itself from tool generation (no self-RPC)', () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    const self = facet({ id: 'caller', rpcSchema: { m: {} } });
    const peer = facet({ id: 'other', rpcSchema: { n: {} } });
    const tools = generateRpcTools('caller', [self, peer], bus);
    expect(tools.map((t) => t.definition.name)).toEqual(['rpc.other.n']);
  });

  it('produces an empty array when no peer declares an rpcSchema', () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    const peer = facet({ id: 'peer' });
    expect(generateRpcTools('caller', [peer], bus)).toEqual([]);
  });

  it('tool executor routes through the bus with caller attribution', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    bus.registerHandler('peer', 'm', async (args) => ({ ok: true, got: args }));
    const peer = facet({ id: 'peer', rpcSchema: { m: {} } });
    const [tool] = generateRpcTools('caller', [peer], bus);
    const result = await tool.executor({ args: { x: 42 } });
    expect(result).toContain('"ok":true');
    expect(result).toContain('"x":42');
    // Trace attributes correctly.
    const trace = bus.getWireTrace();
    expect(trace[0].callerFacetId).toBe('caller');
    expect(trace[0].receiverFacetId).toBe('peer');
  });

  it('returns a synthetic error string when the bus call fails (no-handler)', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    const peer = facet({ id: 'peer', rpcSchema: { m: {} } });
    // Intentionally don't register a handler.
    const [tool] = generateRpcTools('caller', [peer], bus);
    const result = await tool.executor({ args: {} });
    expect(result).toMatch(/^\[rpc-error:no-handler\]/);
  });

  it('passes string handler returns through unchanged', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    bus.registerHandler('peer', 'm', async () => 'plain-string-result');
    const peer = facet({ id: 'peer', rpcSchema: { m: {} } });
    const [tool] = generateRpcTools('caller', [peer], bus);
    const result = await tool.executor({ args: {} });
    expect(result).toBe('plain-string-result');
  });

  it('tool descriptions include params + returns hints from the schema', () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    const peer = facet({
      id: 'peer',
      rpcSchema: {
        lookup: { params: { symbol: 'string' }, returns: { definition: 'string' } },
      },
    });
    const [tool] = generateRpcTools('caller', [peer], bus);
    expect(tool.definition.description).toContain('"symbol":"string"');
    expect(tool.definition.description).toContain('"definition":"string"');
  });

  it('handles undefined args gracefully (defaults to empty object)', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    bus.registerHandler('peer', 'm', async (args) => args);
    const peer = facet({ id: 'peer', rpcSchema: { m: {} } });
    const [tool] = generateRpcTools('caller', [peer], bus);
    const result = await tool.executor({});
    expect(result).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// formatWireTrace
// ---------------------------------------------------------------------------

describe('formatWireTrace', () => {
  it('renders empty trace as a short placeholder', () => {
    expect(formatWireTrace([])).toBe('(no RPC calls)');
  });

  it('renders a successful call with result preview', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    bus.registerHandler('peer', 'm', async () => ({ result: 'ok' }));
    await bus.call('caller', 'peer', 'm', { sample: 1 });
    const text = formatWireTrace(bus.getWireTrace());
    expect(text).toContain('caller → peer.m');
    expect(text).toContain('"result":"ok"');
  });

  it('renders failures with their outcome + error message', async () => {
    const bus = new FacetRpcBus({ timeoutMs: 100 });
    await bus.call('a', 'missing', 'method', {});
    const text = formatWireTrace(bus.getWireTrace());
    expect(text).toContain('no-handler');
    // The wire trace stores the internal errorMessage variant
    // ("No handler registered..."); the caller-facing
    // (`outcome.message`) uses "No facet handler registered...".
    expect(text).toContain('No handler registered');
  });
});
