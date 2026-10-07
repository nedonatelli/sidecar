/**
 * SDK registries.
 *
 * Process-wide singletons that accumulate tools and hooks registered by
 * third-party extensions via `SideCarSdkApi`. The agent loop and tool
 * dispatcher consult these on every run without needing to re-thread
 * the registry through every call site.
 *
 * No VS Code imports — keeps this pure and testable.
 */

import type { RegisteredTool } from '../agent/tools/shared.js';
import type { PolicyHook, HookContext } from '../agent/loop/policyHook.js';

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
  const wrapped = withoutSecrets(hook);
  sdkHooks.push(wrapped);
  return () => {
    const idx = sdkHooks.indexOf(wrapped);
    if (idx !== -1) sdkHooks.splice(idx, 1);
  };
}

/** Config fields that hold credentials. */
const SECRET_CONFIG_FIELDS = [
  'apiKey',
  'fallbackApiKey',
  'webSearchApiKey',
  'zoteroApiKey',
  'mcpServerAuthToken',
] as const;

/**
 * An SDK hook belongs to another extension. VS Code keeps SideCar's
 * SecretStorage from other extensions, and the hook consent prompt says
 * nothing about credentials -- so the run config a hook sees has them
 * removed. (Database profiles go too: they may hold connection passwords.)
 */
function withoutSecrets(hook: PolicyHook): PolicyHook {
  const scrub = (ctx: HookContext): HookContext => {
    const config = { ...ctx.config } as Record<string, unknown>;
    for (const field of SECRET_CONFIG_FIELDS) if (field in config) config[field] = '';
    if ('databaseProfiles' in config) config.databaseProfiles = [];
    return { ...ctx, config: config as unknown as HookContext['config'] };
  };
  const out: PolicyHook = { name: hook.name };
  if (hook.beforeIteration) out.beforeIteration = (state, ctx) => hook.beforeIteration!(state, scrub(ctx));
  if (hook.afterToolResults) out.afterToolResults = (state, ctx) => hook.afterToolResults!(state, scrub(ctx));
  if (hook.onEmptyResponse) out.onEmptyResponse = (state, ctx) => hook.onEmptyResponse!(state, scrub(ctx));
  if (hook.onTermination) out.onTermination = (state, ctx) => hook.onTermination!(state, scrub(ctx));
  return out;
}

/** Returns a shallow copy of the current SDK hooks (safe to pass as `extraPolicyHooks`). */
export function getSdkHooks(): PolicyHook[] {
  return sdkHooks.slice();
}

/** Clear all SDK hooks — used in tests. */
export function clearSdkHooks(): void {
  sdkHooks.splice(0);
}
