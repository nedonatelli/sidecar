import { window, workspace, languages, ExtensionContext, Disposable } from 'vscode';
import { ChatViewProvider } from './webview/chatView.js';
import { TerminalManager } from './terminal/manager.js';
import { SideCarClient } from './ollama/client.js';
import { SideCarCompletionProvider } from './completions/provider.js';
import { getEnableInlineCompletions, getCompletionModel, getCompletionMaxTokens, getModel, getBaseUrl, getApiKey } from './config/settings.js';
import { ProposedContentProvider } from './edits/proposedContentProvider.js';

export function activate(context: ExtensionContext) {
  console.log('SideCar extension activating...');

  const terminalManager = new TerminalManager();
  context.subscriptions.push(terminalManager);

  const proposedContentProvider = new ProposedContentProvider();
  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider('sidecar-proposed', proposedContentProvider)
  );

  const provider = new ChatViewProvider(context, terminalManager, proposedContentProvider);
  context.subscriptions.push(
    window.registerWebviewViewProvider('sidecar.chatView', provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  // Inline completions
  let completionDisposable: Disposable | null = null;

  function registerCompletions() {
    completionDisposable?.dispose();
    completionDisposable = null;

    if (!getEnableInlineCompletions()) return;

    const completionModel = getCompletionModel() || getModel();
    const client = new SideCarClient(completionModel, getBaseUrl(), getApiKey());
    const completionProvider = new SideCarCompletionProvider(client, getCompletionMaxTokens());

    completionDisposable = languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      completionProvider
    );
    context.subscriptions.push(completionDisposable);
  }

  registerCompletions();

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.enableInlineCompletions') ||
          e.affectsConfiguration('sidecar.completionModel') ||
          e.affectsConfiguration('sidecar.completionMaxTokens')) {
        registerCompletions();
      }
    })
  );

  console.log('SideCar extension activated');
}

export function deactivate() {}
