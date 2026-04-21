/**
 * @sidecar/sdk — public entry point (v0.74).
 *
 * Re-exports the full public surface for type-only imports in
 * third-party extensions. Runtime access is always through
 * `vscode.extensions.getExtension('nedonatelli.sidecar')?.exports`.
 */

export type {
  SideCarSdkApi,
  SdkToolOptions,
  ToolDefinition,
  ToolExecutor,
  ToolExecutorContext,
  RegisteredTool,
  PolicyHook,
  HookContext,
} from './types.js';
