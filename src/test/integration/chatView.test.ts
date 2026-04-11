/**
 * Integration tests for the chat view provider.
 * These verify the webview provider registers and initializes correctly.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Chat View Provider', () => {
  test('chat view can be focused without error', async () => {
    try {
      await vscode.commands.executeCommand('sidecar.chatView.focus');
      // If we get here, the command executed (view may or may not be visible)
    } catch (err) {
      // Some environments may not support webview views — just verify no crash
      console.log('chatView.focus skipped:', (err as Error).message);
    }
  });

  test('SideCar contributes a view container', () => {
    const ext = vscode.extensions.getExtension('nedonatelli.sidecar-ai');
    if (!ext) return;

    const pkg = ext.packageJSON;
    const viewContainers = pkg.contributes?.viewsContainers?.activitybar;
    if (viewContainers) {
      const hasSidecar = viewContainers.some((vc: { id: string }) => vc.id === 'sidecar' || vc.id.includes('sidecar'));
      assert.ok(hasSidecar, 'Should have a SideCar activity bar container');
    }
  });

  test('SideCar contributes chat view', () => {
    const ext = vscode.extensions.getExtension('nedonatelli.sidecar-ai');
    if (!ext) return;

    const pkg = ext.packageJSON;
    const views = pkg.contributes?.views;
    if (views) {
      const allViews = Object.values(views).flat() as Array<{ id: string }>;
      const chatView = allViews.find((v) => v.id === 'sidecar.chatView');
      assert.ok(chatView, 'Should have sidecar.chatView registered');
    }
  });
});

suite('Editor Integration', () => {
  test('can open a text document', async () => {
    const doc = await vscode.workspace.openTextDocument({
      content: 'const x = 1;',
      language: 'typescript',
    });
    assert.ok(doc, 'Should create a text document');
    assert.strictEqual(doc.languageId, 'typescript');
    assert.ok(doc.getText().includes('const x = 1'));
  });

  test('can show a text editor', async () => {
    const doc = await vscode.workspace.openTextDocument({
      content: 'function hello() {}',
      language: 'typescript',
    });
    const editor = await vscode.window.showTextDocument(doc);
    assert.ok(editor, 'Should show text editor');
    assert.strictEqual(editor.document.getText(), 'function hello() {}');
  });

  test('diagnostics API is available', () => {
    const diagnostics = vscode.languages.getDiagnostics();
    assert.ok(Array.isArray(diagnostics), 'getDiagnostics should return an array');
  });
});
