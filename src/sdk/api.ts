/**
 * SideCarSdkApi implementation (v0.74).
 *
 * Instantiated once in `extension.ts` and returned from `activate()` so
 * third-party VS Code extensions can obtain it via
 * `vscode.extensions.getExtension('nedonatelli.sidecar')?.exports`.
 *
 * Trust enforcement: each registering extension ID is checked against
 * the workspace-trust store on first registration. Subsequent calls from
 * the same extension ID within the same session skip the prompt.
 */

import type { Disposable, ExtensionContext } from 'vscode';
import { checkWorkspaceConfigTrust } from '../config/workspaceTrust.js';
import { addSdkTool, addSdkHook } from './registry.js';
import type { ToolDefinition } from '../ollama/types.js';
import type { ToolExecutor } from '../agent/tools/shared.js';
import type { PolicyHook } from '../agent/loop/policyHook.js';
import type { SideCarSdkApi, SdkToolOptions } from './types.js';

/** Extension IDs that have been trusted in this session (cleared on deactivation). */
const trustedExtensions = new Set<string>();

export function createSdkApi(context: ExtensionContext, version: string): SideCarSdkApi {
  return {
    version,

    registerTool(definition: ToolDefinition, executor: ToolExecutor, options: SdkToolOptions = {}): Disposable {
      const callerId = resolveCallerId();
      void ensureTrusted(callerId, definition.name);

      const tool = {
        definition,
        executor,
        requiresApproval: options.requiresApproval ?? true,
      };
      const remove = addSdkTool(tool);
      const disposable: Disposable = { dispose: remove };
      context.subscriptions.push(disposable);
      return disposable;
    },

    registerHook(hook: PolicyHook): Disposable {
      const remove = addSdkHook(hook);
      const disposable: Disposable = { dispose: remove };
      context.subscriptions.push(disposable);
      return disposable;
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Attempt to identify the calling extension by walking the JS call stack.
 * Returns `'unknown'` when the caller cannot be determined (e.g. in tests).
 */
function resolveCallerId(): string {
  try {
    const stack = new Error().stack ?? '';
    // Stack lines look like "at ... (file:///...extensions/<publisher.name>-<ver>/...)"
    const match = stack.match(/extensions[/\\]([^/\\]+\.[^/\\-]+)-[\d.]+[/\\]/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function ensureTrusted(extensionId: string, toolName: string): Promise<void> {
  if (trustedExtensions.has(extensionId)) return;
  const result = await checkWorkspaceConfigTrust(
    'sdkTools',
    `Extension "${extensionId}" wants to register a tool "${toolName}" in SideCar. ` +
      `Only allow this from extensions you trust — registered tools can execute code on your behalf.`,
  );
  if (result === 'blocked') {
    throw new Error(`SideCar SDK: trust denied for extension "${extensionId}" (tool "${toolName}")`);
  }
  trustedExtensions.add(extensionId);
}
