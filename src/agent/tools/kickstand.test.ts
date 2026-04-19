import { describe, it, expect, vi } from 'vitest';
import { kickstandListLoras, kickstandAttachLora, kickstandDetachLora, kickstandTools } from './kickstand.js';
import type { ToolExecutorContext } from './shared.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { BackendCapabilities } from '../../ollama/backend.js';

// ---------------------------------------------------------------------------
// Tests for tools/kickstand.ts (v0.67.1).
//
// Three agent tools wrapping the existing `loraAdapters` backend
// capability. Tests cover capability-gate (no-capability surface),
// happy paths, input validation, and error propagation.
// ---------------------------------------------------------------------------

function makeContext(caps: BackendCapabilities | undefined): ToolExecutorContext {
  const client = {
    getBackendCapabilities: () => caps,
  } as unknown as SideCarClient;
  return { client };
}

function makeLoraCaps(overrides: Partial<NonNullable<BackendCapabilities['loraAdapters']>> = {}): BackendCapabilities {
  return {
    loraAdapters: {
      listAdapters: async () => [],
      loadAdapter: async () => 'attached',
      unloadAdapter: async () => 'detached',
      ...overrides,
    },
  };
}

describe('kickstand_list_loras', () => {
  it('returns the "not supported" message when the active backend has no loraAdapters capability', async () => {
    const out = await kickstandListLoras({ model_id: 'base' }, makeContext(undefined));
    expect(out).toMatch(/loraAdapters capability/);
    expect(out).toMatch(/switch_backend/);
  });

  it('returns "not supported" when client exists but capability is absent (Ollama-style backend)', async () => {
    const out = await kickstandListLoras({ model_id: 'base' }, makeContext({}));
    expect(out).toMatch(/loraAdapters capability/);
  });

  it('returns an error when model_id is missing', async () => {
    const out = await kickstandListLoras({}, makeContext(makeLoraCaps()));
    expect(out).toMatch(/model_id is required/);
  });

  it('renders an empty-adapter message when the model has zero attached adapters', async () => {
    const caps = makeLoraCaps({ listAdapters: async () => [] });
    const out = await kickstandListLoras({ model_id: 'base' }, makeContext(caps));
    expect(out).toBe('No LoRA adapters currently attached to base.');
  });

  it('renders every adapter with id + scale + path on success', async () => {
    const caps = makeLoraCaps({
      listAdapters: async () => [
        { id: 'ad-1', path: '/a/one.gguf', scale: 1.0 },
        { id: 'ad-2', path: '/a/two.gguf', scale: 0.5 },
      ],
    });
    const out = await kickstandListLoras({ model_id: 'base' }, makeContext(caps));
    expect(out).toMatch(/^2 adapter\(s\) on base:/);
    expect(out).toMatch(/ad-1 \(scale 1\) → \/a\/one\.gguf/);
    expect(out).toMatch(/ad-2 \(scale 0\.5\) → \/a\/two\.gguf/);
  });

  it('catches rejection from listAdapters and returns an error string', async () => {
    const caps = makeLoraCaps({
      listAdapters: async () => {
        throw new Error('connection refused');
      },
    });
    const out = await kickstandListLoras({ model_id: 'base' }, makeContext(caps));
    expect(out).toMatch(/Failed to list adapters on base.*connection refused/);
  });
});

describe('kickstand_attach_lora', () => {
  it('returns "not supported" when capability is absent', async () => {
    const out = await kickstandAttachLora({ model_id: 'base', path: '/a.gguf' }, makeContext(undefined));
    expect(out).toMatch(/loraAdapters capability/);
  });

  it('returns an error when model_id is missing', async () => {
    const out = await kickstandAttachLora({ path: '/a.gguf' }, makeContext(makeLoraCaps()));
    expect(out).toMatch(/model_id is required/);
  });

  it('returns an error when path is missing', async () => {
    const out = await kickstandAttachLora({ model_id: 'base' }, makeContext(makeLoraCaps()));
    expect(out).toMatch(/path is required/);
  });

  it('forwards scale when supplied and returns the capability summary', async () => {
    const loadAdapter = vi.fn().mockResolvedValue('Loaded LoRA ad-1 on base');
    const caps = makeLoraCaps({ loadAdapter });
    const out = await kickstandAttachLora({ model_id: 'base', path: '/a.gguf', scale: 0.75 }, makeContext(caps));
    expect(loadAdapter).toHaveBeenCalledWith('base', '/a.gguf', 0.75);
    expect(out).toBe('Loaded LoRA ad-1 on base');
  });

  it('omits scale from the capability call when not supplied (capability default takes over)', async () => {
    const loadAdapter = vi.fn().mockResolvedValue('ok');
    const caps = makeLoraCaps({ loadAdapter });
    await kickstandAttachLora({ model_id: 'base', path: '/a.gguf' }, makeContext(caps));
    expect(loadAdapter).toHaveBeenCalledWith('base', '/a.gguf', undefined);
  });

  it('ignores NaN scale and falls back to undefined', async () => {
    const loadAdapter = vi.fn().mockResolvedValue('ok');
    const caps = makeLoraCaps({ loadAdapter });
    await kickstandAttachLora({ model_id: 'base', path: '/a.gguf', scale: NaN }, makeContext(caps));
    expect(loadAdapter).toHaveBeenCalledWith('base', '/a.gguf', undefined);
  });

  it('catches rejection from loadAdapter and returns an error string', async () => {
    const caps = makeLoraCaps({
      loadAdapter: async () => {
        throw new Error('invalid adapter format');
      },
    });
    const out = await kickstandAttachLora({ model_id: 'base', path: '/a.gguf' }, makeContext(caps));
    expect(out).toMatch(/Failed to attach adapter to base.*invalid adapter format/);
  });
});

describe('kickstand_detach_lora', () => {
  it('returns "not supported" when capability is absent', async () => {
    const out = await kickstandDetachLora({ model_id: 'base', adapter_id: 'ad-1' }, makeContext(undefined));
    expect(out).toMatch(/loraAdapters capability/);
  });

  it('returns an error when model_id is missing', async () => {
    const out = await kickstandDetachLora({ adapter_id: 'ad-1' }, makeContext(makeLoraCaps()));
    expect(out).toMatch(/model_id is required/);
  });

  it('returns an error when adapter_id is missing', async () => {
    const out = await kickstandDetachLora({ model_id: 'base' }, makeContext(makeLoraCaps()));
    expect(out).toMatch(/adapter_id is required/);
  });

  it('calls unloadAdapter with both ids and returns the capability summary', async () => {
    const unloadAdapter = vi.fn().mockResolvedValue('Unloaded LoRA ad-1 from base');
    const caps = makeLoraCaps({ unloadAdapter });
    const out = await kickstandDetachLora({ model_id: 'base', adapter_id: 'ad-1' }, makeContext(caps));
    expect(unloadAdapter).toHaveBeenCalledWith('base', 'ad-1');
    expect(out).toBe('Unloaded LoRA ad-1 from base');
  });

  it('catches rejection from unloadAdapter and returns an error string', async () => {
    const caps = makeLoraCaps({
      unloadAdapter: async () => {
        throw new Error('adapter not found');
      },
    });
    const out = await kickstandDetachLora({ model_id: 'base', adapter_id: 'ad-missing' }, makeContext(caps));
    expect(out).toMatch(/Failed to detach adapter ad-missing.*adapter not found/);
  });
});

describe('kickstandTools registry wiring', () => {
  it('exposes three registered tools in the expected order', () => {
    expect(kickstandTools).toHaveLength(3);
    expect(kickstandTools.map((t) => t.definition.name)).toEqual([
      'kickstand_list_loras',
      'kickstand_attach_lora',
      'kickstand_detach_lora',
    ]);
  });

  it('list is read-only (no approval), attach + detach require approval', () => {
    const byName = Object.fromEntries(kickstandTools.map((t) => [t.definition.name, t]));
    expect(byName['kickstand_list_loras'].requiresApproval).toBe(false);
    expect(byName['kickstand_attach_lora'].requiresApproval).toBe(true);
    expect(byName['kickstand_detach_lora'].requiresApproval).toBe(true);
  });

  it('none of the tools set alwaysRequireApproval — ephemeral state, user may opt into auto-approve', () => {
    for (const t of kickstandTools) {
      // alwaysRequireApproval is optional; undefined means "not set".
      expect((t as { alwaysRequireApproval?: boolean }).alwaysRequireApproval).toBeFalsy();
    }
  });
});
