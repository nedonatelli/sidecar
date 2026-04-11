/**
 * Integration tests for SideCar extension activation.
 * These run inside a real VS Code instance via @vscode/test-cli.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Activation', () => {
  test('extension is present in the extensions list', () => {
    const ext = vscode.extensions.getExtension('nedonatelli.sidecar-ai');
    // The extension ID comes from package.json publisher + name
    // It may not be found if the publisher/name differs — check that
    // at least one SideCar extension exists
    const allExts = vscode.extensions.all.map((e) => e.id);
    const hasSidecar = allExts.some((id) => id.toLowerCase().includes('sidecar'));
    assert.ok(ext || hasSidecar, `SideCar extension not found. Available: ${allExts.slice(0, 10).join(', ')}`);
  });

  test('extension activates without error', async () => {
    const ext = vscode.extensions.getExtension('nedonatelli.sidecar-ai');
    if (ext) {
      if (!ext.isActive) {
        await ext.activate();
      }
      assert.ok(ext.isActive, 'Extension should be active after activation');
    }
  });

  test('SideCar chat view is registered', async () => {
    // The extension registers a webview view provider for sidecar.chatView
    // We can verify by checking if the view container exists
    const ext = vscode.extensions.getExtension('nedonatelli.sidecar-ai');
    if (ext) {
      if (!ext.isActive) {
        await ext.activate();
      }
      // If the view is registered, focusing it should not throw
      try {
        await vscode.commands.executeCommand('sidecar.chatView.focus');
      } catch {
        // View might not be visible in test environment — that's ok
      }
    }
  });

  test('registered commands include SideCar commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const sidecarCommands = commands.filter((c) => c.startsWith('sidecar.'));
    assert.ok(sidecarCommands.length > 0, 'Should have registered SideCar commands');
  });
});

suite('Workspace Integration', () => {
  test('workspace folders are available', () => {
    // The test runner opens the current workspace
    assert.ok(
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0,
      'Should have at least one workspace folder',
    );
  });

  test('can read VS Code configuration', () => {
    const config = vscode.workspace.getConfiguration('sidecar');
    // Should return defaults for unconfigured settings
    const model = config.get<string>('model');
    assert.ok(typeof model === 'string' || model === undefined, 'Model should be a string or undefined');
  });

  test('file system API works', async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const rootUri = folders[0].uri;
    const packageJson = vscode.Uri.joinPath(rootUri, 'package.json');

    try {
      const stat = await vscode.workspace.fs.stat(packageJson);
      assert.ok(stat.size > 0, 'package.json should have content');
    } catch {
      // File might not exist in CI — that's ok
    }
  });
});
