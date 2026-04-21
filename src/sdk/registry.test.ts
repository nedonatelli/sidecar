import { describe, it, expect, beforeEach } from 'vitest';
import {
  addSdkTool,
  findSdkTool,
  getSdkToolDefinitions,
  clearSdkTools,
  addSdkHook,
  getSdkHooks,
  clearSdkHooks,
} from './registry.js';
import type { RegisteredTool } from '../agent/tools/shared.js';
import type { PolicyHook } from '../agent/loop/policyHook.js';

function makeTool(name: string): RegisteredTool {
  return {
    definition: { name, description: `desc-${name}`, input_schema: { type: 'object', properties: {}, required: [] } },
    executor: async () => `result-${name}`,
    requiresApproval: false,
  };
}

describe('SDK tool registry', () => {
  beforeEach(() => {
    clearSdkTools();
    clearSdkHooks();
  });

  it('registers and finds a tool by name', () => {
    addSdkTool(makeTool('my_tool'));
    expect(findSdkTool('my_tool')?.definition.name).toBe('my_tool');
  });

  it('returns undefined for unknown tool', () => {
    expect(findSdkTool('nope')).toBeUndefined();
  });

  it('teardown removes the tool', () => {
    const remove = addSdkTool(makeTool('temp_tool'));
    remove();
    expect(findSdkTool('temp_tool')).toBeUndefined();
  });

  it('duplicate name replaces previous registration', () => {
    addSdkTool(makeTool('dup'));
    const second = makeTool('dup');
    second.definition.description = 'updated';
    addSdkTool(second);
    expect(findSdkTool('dup')?.definition.description).toBe('updated');
  });

  it('getSdkToolDefinitions returns all registered tools', () => {
    addSdkTool(makeTool('a'));
    addSdkTool(makeTool('b'));
    const defs = getSdkToolDefinitions();
    expect(defs.map((t) => t.definition.name).sort()).toEqual(['a', 'b']);
  });
});

describe('SDK hook registry', () => {
  beforeEach(() => {
    clearSdkTools();
    clearSdkHooks();
  });

  it('registers and returns a hook', () => {
    const hook: PolicyHook = { name: 'test-hook', beforeIteration: async () => undefined };
    addSdkHook(hook);
    expect(getSdkHooks()).toHaveLength(1);
  });

  it('teardown removes the hook', () => {
    const hook: PolicyHook = { name: 'temp-hook', beforeIteration: async () => undefined };
    const remove = addSdkHook(hook);
    remove();
    expect(getSdkHooks()).toHaveLength(0);
  });

  it('getSdkHooks returns a shallow copy', () => {
    const hook: PolicyHook = { name: 'copy-hook', beforeIteration: async () => undefined };
    addSdkHook(hook);
    const copy = getSdkHooks();
    copy.splice(0);
    expect(getSdkHooks()).toHaveLength(1);
  });
});
