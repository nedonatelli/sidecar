/**
 * SDK registries (v0.74).
 *
 * Process-wide singletons that accumulate tools and hooks registered by
 * third-party extensions via `SideCarSdkApi`. The agent loop and tool
 * dispatcher consult these on every run without needing to re-thread
 * the registry through every call site.
 *
 * No VS Code imports — keeps this pure and testable.
 */

import type { RegisteredTool } from '../agent/tools/shared.js';
import type { PolicyHook } from '../agent/loop/policyHook.js';

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const sdkTools = new Map<string, RegisteredTool>();

/**
 * Add a tool. Returns a teardown function that removes it.
 * Duplicate names replace the previous registration silently.
 */
export function addSdkTool(tool: RegisteredTool): () => void {
  sdkTools.set(tool.definition.name, tool);
  return () => sdkTools.delete(tool.definition.name);
}

/** Look up a tool registered via the SDK. Returns `undefined` when not found. */
export function findSdkTool(name: string): RegisteredTool | undefined {
  return sdkTools.get(name);
}

/** All SDK tool definitions (for LLM catalog assembly). */
export function getSdkToolDefinitions(): RegisteredTool[] {
  return Array.from(sdkTools.values());
}

/** Clear all SDK tools — used in tests. */
export function clearSdkTools(): void {
  sdkTools.clear();
}

// ---------------------------------------------------------------------------
// Hook registry
// ---------------------------------------------------------------------------

const sdkHooks: PolicyHook[] = [];

/**
 * Add a policy hook. Returns a teardown function that removes it.
 */
export function addSdkHook(hook: PolicyHook): () => void {
  sdkHooks.push(hook);
  return () => {
    const idx = sdkHooks.indexOf(hook);
    if (idx !== -1) sdkHooks.splice(idx, 1);
  };
}

/** Returns a shallow copy of the current SDK hooks (safe to pass as `extraPolicyHooks`). */
export function getSdkHooks(): PolicyHook[] {
  return sdkHooks.slice();
}

/** Clear all SDK hooks — used in tests. */
export function clearSdkHooks(): void {
  sdkHooks.splice(0);
}
