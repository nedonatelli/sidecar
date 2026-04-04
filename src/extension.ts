import { window, ExtensionContext } from 'vscode';
import { ChatViewProvider } from './webview/chatView.js';

export function activate(context: ExtensionContext) {
  console.log('SideCar extension activating...');

  const provider = new ChatViewProvider(context);
  context.subscriptions.push(
    window.registerWebviewViewProvider('sidecar.chatView', provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  console.log('SideCar extension activated');
}

export function deactivate() {}
