import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSdkApi } from './api.js';
import { clearSdkTools, clearSdkHooks, findSdkTool, getSdkHooks } from './registry.js';
import type { ExtensionContext, Disposable } from 'vscode';

vi.mock('../config/workspaceTrust.js', () => ({
  checkWorkspaceConfigTrust: vi.fn().mockResolvedValue('trusted'),
}));

import { checkWorkspaceConfigTrust } from '../config/workspaceTrust.js';
const mockedTrust = vi.mocked(checkWorkspaceConfigTrust);

function makeContext(): ExtensionContext {
  return {
    subscriptions: [] as Disposable[],
    extension: { packageJSON: { version: '0.74.0' } },
  } as unknown as ExtensionContext;
}

describe('createSdkApi', () => {
  beforeEach(() => {
    clearSdkTools();
    clearSdkHooks();
    mockedTrust.mockResolvedValue('trusted');
  });

  it('exposes the version', () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    expect(api.version).toBe('0.74.0');
  });

  it('registerTool adds tool to the SDK registry', async () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    const def = {
      name: 'hello',
      description: 'hi',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    };
    const executor = async () => 'ok';
    api.registerTool(def, executor, { requiresApproval: false });
    // trust prompt is async — wait a tick
    await Promise.resolve();
    const found = findSdkTool('hello');
    expect(found?.definition.name).toBe('hello');
    expect(found?.requiresApproval).toBe(false);
  });

  it('registerTool returns a disposable that removes the tool', async () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    const def = {
      name: 'temp',
      description: 'x',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    };
    const disposable = api.registerTool(def, async () => '', { requiresApproval: false });
    await Promise.resolve();
    expect(findSdkTool('temp')).toBeDefined();
    disposable.dispose();
    expect(findSdkTool('temp')).toBeUndefined();
  });

  it('registerHook adds hook to the SDK registry', () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    const hook = { name: 'my-hook', beforeIteration: async () => undefined };
    api.registerHook(hook);
    expect(getSdkHooks()).toHaveLength(1);
  });

  it('registerHook returns a disposable that removes the hook', () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    const hook = { name: 'temp-hook', afterToolResults: async () => undefined };
    const disposable = api.registerHook(hook);
    expect(getSdkHooks()).toHaveLength(1);
    disposable.dispose();
    expect(getSdkHooks()).toHaveLength(0);
  });

  it('trusted extension ID is cached — trust prompt fires only once', async () => {
    const api = createSdkApi(makeContext(), '0.74.0');
    const def = (n: string) => ({
      name: n,
      description: 'x',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    });
    api.registerTool(def('t1'), async () => '');
    api.registerTool(def('t2'), async () => '');
    await new Promise((r) => setTimeout(r, 10));
    expect(mockedTrust).toHaveBeenCalledOnce();
  });
});
