import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, type ExtensionContext, type Disposable } from 'vscode';
import { createSdkApi, resetSdkTrustForTests } from './api.js';
import { clearSdkTools, clearSdkHooks, findSdkTool, getSdkHooks } from './registry.js';

const prompt = vi.mocked(window.showWarningMessage);

function makeContext(): ExtensionContext {
  return {
    subscriptions: [] as Disposable[],
    extensionPath: '/home/u/.vscode/extensions/nedonatelli.sidecar-ai-0.126.0',
    extension: { packageJSON: { version: '0.74.0' } },
  } as unknown as ExtensionContext;
}

const def = (name: string) => ({
  name,
  description: 'x',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
});
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('createSdkApi', () => {
  beforeEach(() => {
    clearSdkTools();
    clearSdkHooks();
    resetSdkTrustForTests();
    prompt.mockReset().mockResolvedValue('Allow' as never);
  });

  it('exposes the version', () => {
    expect(createSdkApi(makeContext(), '0.74.0').version).toBe('0.74.0');
  });

  it('registerTool adds the tool once the extension is allowed', async () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    api.registerTool(def('hello'), async () => 'ok', { requiresApproval: false });
    await settle();
    const found = findSdkTool('hello');
    expect(found?.definition.name).toBe('hello');
    expect(found?.requiresApproval).toBe(false);
  });

  it('registerTool returns a disposable that removes the tool', async () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    const disposable = api.registerTool(def('temp'), async () => '', { requiresApproval: false });
    await settle();
    expect(findSdkTool('temp')).toBeDefined();
    disposable.dispose();
    expect(findSdkTool('temp')).toBeUndefined();
  });

  it('registerHook adds the hook once allowed, and its disposable removes it', async () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    const disposable = api.registerHook({ name: 'my-hook', beforeIteration: async () => undefined });
    await settle();
    expect(getSdkHooks()).toHaveLength(1);
    disposable.dispose();
    expect(getSdkHooks()).toHaveLength(0);
  });

  // Nothing goes live before the user says yes: a tool runs code for the user,
  // and a hook sees every conversation and the run's config.
  it('registers nothing before the decision, and nothing at all when blocked', async () => {
    let answer: (v: unknown) => void = () => {};
    prompt.mockReturnValue(new Promise((r) => (answer = r)) as never);
    const api = createSdkApi(makeContext(), '0.74.0');
    api.registerTool(def('pending'), async () => '');
    api.registerHook({ name: 'pending-hook', beforeIteration: async () => undefined });
    await settle();
    expect(findSdkTool('pending')).toBeUndefined();
    expect(getSdkHooks()).toHaveLength(0);

    answer(undefined); // the user dismissed the modal: not allowed
    await settle();
    expect(findSdkTool('pending')).toBeUndefined();
    expect(getSdkHooks()).toHaveLength(0);
  });

  it('a registration disposed before the decision never goes live', async () => {
    let answer: (v: unknown) => void = () => {};
    prompt.mockReturnValue(new Promise((r) => (answer = r)) as never);
    const api = createSdkApi(makeContext(), '0.74.0');
    api.registerTool(def('gone'), async () => '').dispose();
    answer('Allow');
    await settle();
    expect(findSdkTool('gone')).toBeUndefined();
  });

  it('asks once per extension, even for concurrent registrations', async () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    api.registerTool(def('t1'), async () => '');
    api.registerTool(def('t2'), async () => '');
    api.registerHook({ name: 'h', beforeIteration: async () => undefined });
    await settle();
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0][1]).toEqual({ modal: true });
    expect(findSdkTool('t1')).toBeDefined();
    expect(findSdkTool('t2')).toBeDefined();
  });
});
