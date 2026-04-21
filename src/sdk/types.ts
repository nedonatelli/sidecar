/**
 * @sidecar/sdk — public type surface (v0.74).
 *
 * Re-exports the minimal subset of internal types that third-party
 * extensions need to register tools and hooks. Internal helpers stay
 * behind `src/agent/` and are NOT part of the public contract.
 *
 * Do not import from `../agent/` in this file — only from
 * `../ollama/types.js` and `../agent/tools/shared.js` (the stable
 * shared primitives). Anything else belongs in the internal tree.
 */

export type { ToolDefinition } from '../ollama/types.js';
export type { ToolExecutor, ToolExecutorContext, RegisteredTool } from '../agent/tools/shared.js';
export type { PolicyHook, HookContext } from '../agent/loop/policyHook.js';

/**
 * Options for `SideCarSdkApi.registerTool`.
 */
export interface SdkToolOptions {
  /**
   * Whether the tool requires user approval before each call.
   * Defaults to `true` — set `false` for read-only / non-destructive tools.
   */
  requiresApproval?: boolean;
}

/**
 * The full public API surface exposed by the SideCar extension.
 * Third-party VS Code extensions obtain this object via:
 *
 * ```ts
 * import type { SideCarSdkApi } from 'nedonatelli.sidecar'; // type-only
 * const api = vscode.extensions.getExtension('nedonatelli.sidecar')?.exports as SideCarSdkApi;
 * ```
 */
export interface SideCarSdkApi {
  /** Semver version of the running SideCar extension (e.g. `"0.74.0"`). */
  readonly version: string;

  /**
   * Register a tool that will appear in the agent's tool catalog for every
   * subsequent agent run. Returns a `Disposable`; calling `.dispose()` removes
   * the tool from the registry immediately.
   *
   * The first call from a new extension ID triggers a one-time workspace-
   * scoped trust prompt. If the user declines, registration throws.
   */
  registerTool(
    definition: import('../ollama/types.js').ToolDefinition,
    executor: import('../agent/tools/shared.js').ToolExecutor,
    options?: SdkToolOptions,
  ): import('vscode').Disposable;

  /**
   * Register a policy hook that fires on every agent loop iteration.
   * Returns a `Disposable`; calling `.dispose()` removes the hook.
   */
  registerHook(hook: import('../agent/loop/policyHook.js').PolicyHook): import('vscode').Disposable;
}
