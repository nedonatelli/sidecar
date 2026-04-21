/**
 * SideCar SDK — "hello-tool" example extension.
 *
 * Shows the minimal wiring to register a custom agent tool via the
 * SideCar public API. Activate this extension alongside SideCar and
 * the agent will see a `greet` tool it can call.
 *
 * Usage:
 *   1. Copy this directory into your VS Code extension workspace.
 *   2. Run `npm install` and compile with `tsc`.
 *   3. Add `"extensionDependencies": ["nedonatelli.sidecar"]` to package.json.
 */

import * as vscode from 'vscode';
import type { SideCarSdkApi } from 'nedonatelli.sidecar';

export function activate(context: vscode.ExtensionContext) {
  const sidecar = vscode.extensions.getExtension<SideCarSdkApi>('nedonatelli.sidecar');
  if (!sidecar?.isActive) {
    console.warn('hello-tool: SideCar is not active, skipping tool registration');
    return;
  }

  const api = sidecar.exports;

  const disposable = api.registerTool(
    {
      name: 'greet',
      description: 'Return a friendly greeting for the given name.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name to greet' },
        },
        required: ['name'],
      },
    },
    async (input) => {
      const name = (input.name as string) ?? 'world';
      return `Hello, ${name}! (registered by hello-tool example extension)`;
    },
    { requiresApproval: false },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
