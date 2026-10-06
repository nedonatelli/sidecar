/**
 * SideCarSdkApi implementation.
 *
 * Instantiated once in `extension.ts` and returned from `activate()` so
 * third-party VS Code extensions can obtain it via
 * `vscode.extensions.getExtension('nedonatelli.sidecar')?.exports`.
 *
 * Trust enforcement: nothing an extension registers goes live until the user
 * explicitly allows that extension in a modal prompt. A tool runs code on the
 * user's behalf, and a hook sees every conversation and the run's config, so
 * both are gated. The decision is remembered for the session, per extension.
 */

import { window, type Disposable, type ExtensionContext } from 'vscode';
import { addSdkTool, addSdkHook } from './registry.js';
import type { ToolDefinition } from '../ollama/types.js';
import type { ToolExecutor } from '../agent/tools/shared.js';
import type { PolicyHook } from '../agent/loop/policyHook.js';
import type { SideCarSdkApi, SdkToolOptions } from './types.js';

/** Per-session decisions, by extension id. An in-flight prompt is shared. */
const decisions = new Map<string, Promise<boolean>>();

/** For tests: forget every decision. */
export function resetSdkTrustForTests(): void {
  decisions.clear();
}

export function createSdkApi(context: ExtensionContext, version: string): SideCarSdkApi {
  /**
   * Register only after the caller is allowed. Returns a Disposable at once,
   * as the API promises; disposing before the decision cancels the
   * registration, and a Block leaves nothing registered.
   */
  const gated = (what: string, add: () => () => void): Disposable => {
    const callerId = resolveCallerId(context);
    let remove: (() => void) | undefined;
    let disposed = false;
    void approve(callerId, what).then((allowed) => {
      if (allowed && !disposed) remove = add();
    });
    const disposable: Disposable = {
      dispose: () => {
        disposed = true;
        remove?.();
      },
    };
    context.subscriptions.push(disposable);
    return disposable;
  };

  return {
    version,

    registerTool(definition: ToolDefinition, executor: ToolExecutor, options: SdkToolOptions = {}): Disposable {
      return gated(`register a tool "${definition.name}" that can run code on your behalf`, () =>
        addSdkTool({ definition, executor, requiresApproval: options.requiresApproval ?? true }),
      );
    },

    registerHook(hook: PolicyHook): Disposable {
      return gated(`install a hook "${hook.name}" that sees every agent conversation and can steer it`, () =>
        addSdkHook(hook),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function approve(extensionId: string, what: string): Promise<boolean> {
  let decision = decisions.get(extensionId);
  if (!decision) {
    const who = extensionId === 'unknown' ? 'An unidentified extension' : `Extension "${extensionId}"`;
    decision = Promise.resolve(
      window.showWarningMessage(
        `${who} wants to ${what} in SideCar. Only allow extensions you trust.`,
        { modal: true },
        'Allow',
      ),
    ).then(
      (choice) => choice === 'Allow',
      () => false,
    );
    decisions.set(extensionId, decision);
  }
  return decision;
}

/**
 * Identify the calling extension from the call stack: the first frame inside
 * an `extensions/<publisher.name>-<version>/` folder that is NOT SideCar's own
 * install -- SideCar's bundle is always on the stack above the caller, so the
 * first match was always SideCar itself. `'unknown'` when no frame matches
 * (tests, or an extension loaded from a development path).
 */
function resolveCallerId(context: ExtensionContext): string {
  try {
    const own = normalize(context.extensionPath ?? '');
    const frame = /extensions[/\\]([^/\\]+\.[^/\\]+?)-\d[\w.-]*[/\\]/;
    for (const line of (new Error().stack ?? '').split('\n')) {
      if (own && normalize(line).includes(own)) continue;
      const match = frame.exec(line);
      if (match) return match[1];
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}
