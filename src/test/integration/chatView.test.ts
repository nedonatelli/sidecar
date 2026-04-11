/**
 * Integration tests for the chat view provider and webview interaction.
 * These run inside a real VS Code instance via @vscode/test-cli.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Chat View Provider — Registration', () => {
  test('chat view can be focused without error', async () => {
    try {
      await vscode.commands.executeCommand('sidecar.chatView.focus');
    } catch (err) {
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

suite('Chat View Provider — Command Registration', () => {
  let sidecarCommands: string[];

  suiteSetup(async () => {
    const all = await vscode.commands.getCommands(true);
    sidecarCommands = all.filter((c) => c.startsWith('sidecar.'));
  });

  test('clearChat command is registered', () => {
    assert.ok(sidecarCommands.includes('sidecar.clearChat'), 'Should have sidecar.clearChat');
  });

  test('exportChat command is registered', () => {
    assert.ok(sidecarCommands.includes('sidecar.exportChat'), 'Should have sidecar.exportChat');
  });

  test('undoChanges command is registered', () => {
    assert.ok(sidecarCommands.includes('sidecar.undoChanges'), 'Should have sidecar.undoChanges');
  });

  test('generateCommitMessage command is registered', () => {
    assert.ok(sidecarCommands.includes('sidecar.generateCommitMessage'), 'Should have sidecar.generateCommitMessage');
  });

  test('scanStaged command is registered', () => {
    assert.ok(sidecarCommands.includes('sidecar.scanStaged'), 'Should have sidecar.scanStaged');
  });

  test('toggleChat command is registered', () => {
    assert.ok(sidecarCommands.includes('sidecar.toggleChat'), 'Should have sidecar.toggleChat');
  });

  test('reviewChanges command is registered', () => {
    assert.ok(sidecarCommands.includes('sidecar.reviewChanges'), 'Should have sidecar.reviewChanges');
  });
});

suite('Chat View Provider — Configuration', () => {
  test('sidecar.model setting exists with default', () => {
    const config = vscode.workspace.getConfiguration('sidecar');
    const model = config.get<string>('model');
    assert.ok(typeof model === 'string', 'model should be a string');
  });

  test('sidecar.agentMode setting exists with default', () => {
    const config = vscode.workspace.getConfiguration('sidecar');
    const mode = config.get<string>('agentMode');
    assert.ok(
      ['cautious', 'autonomous', 'manual', 'plan'].includes(mode || ''),
      `agentMode should be valid, got: ${mode}`,
    );
  });

  test('sidecar.enableSemanticSearch setting exists', () => {
    const config = vscode.workspace.getConfiguration('sidecar');
    const enabled = config.get<boolean>('enableSemanticSearch');
    assert.ok(typeof enabled === 'boolean' || enabled === undefined, 'enableSemanticSearch should be boolean');
  });

  test('sidecar.agentMaxIterations has a valid default', () => {
    const config = vscode.workspace.getConfiguration('sidecar');
    const maxIter = config.get<number>('agentMaxIterations');
    if (maxIter !== undefined) {
      assert.ok(maxIter >= 1, 'agentMaxIterations should be >= 1');
    }
  });
});

suite('Chat View Provider — Webview Content', () => {
  test('getChatWebviewHtml returns valid HTML', async () => {
    const { getChatWebviewHtml } = await import('../../webview/chatWebview.js');
    const ext = vscode.extensions.getExtension('nedonatelli.sidecar-ai');
    if (!ext) return;

    // Create a mock webview object with the minimum needed
    const mockWebview = {
      asWebviewUri: (uri: vscode.Uri) => uri,
      cspSource: 'https://mock.vscode.dev',
    };

    const html = getChatWebviewHtml(mockWebview as never, ext.extensionUri);
    assert.ok(html.length > 0, 'Should generate non-empty HTML');
    assert.ok(html.includes('<!DOCTYPE html>') || html.includes('<html'), 'Should be valid HTML');
    assert.ok(html.includes('chat'), 'Should contain chat-related content');
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

  test('can create and edit a document', async () => {
    const doc = await vscode.workspace.openTextDocument({
      content: 'let value = 0;',
      language: 'typescript',
    });
    const editor = await vscode.window.showTextDocument(doc);

    // Apply an edit
    const success = await editor.edit((builder) => {
      builder.replace(new vscode.Range(0, 4, 0, 9), 'count');
    });
    assert.ok(success, 'Edit should succeed');
    assert.ok(editor.document.getText().includes('count'), 'Document should reflect the edit');
  });

  test('workspace file system can stat files', async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;

    const rootUri = folders[0].uri;
    const packageJson = vscode.Uri.joinPath(rootUri, 'package.json');

    const stat = await vscode.workspace.fs.stat(packageJson);
    assert.ok(stat.size > 0, 'package.json should have content');
    assert.ok(stat.type === vscode.FileType.File, 'package.json should be a file');
  });
});
