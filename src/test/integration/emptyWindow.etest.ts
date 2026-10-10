import * as assert from 'assert';
import * as vscode from 'vscode';

// Runs in a VS Code window with NO folder open (the `empty-window` config in
// .vscode-test.mjs). Activation used to fail in every such window: the
// .sidecar/ directory object existed but was never initialised, passed every
// "is there a .sidecar?" check, and then threw from getPath() (#142).
// The `.etest` suffix keeps this file out of the main run, which opens a folder.

suite('SideCar in a window with no folder open', () => {
  test('there really is no folder', () => {
    assert.strictEqual(vscode.workspace.workspaceFolders, undefined);
  });

  test('the extension activates', async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension('nedonatelli.sidecar-ai');
    assert.ok(ext, 'the extension is installed in the test host');
    await ext.activate(); // throws if activate() throws
    assert.ok(ext.isActive);
  });

  test('its commands are registered and the chat view opens', async function () {
    this.timeout(60_000);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('sidecar.clearChat'), 'sidecar.clearChat is registered');
    await vscode.commands.executeCommand('sidecar.chatView.focus'); // not swallowed: an error fails the test
  });
});
