import { window, Uri, ExtensionContext, commands } from 'vscode';
import * as fs from 'fs/promises';
import { buildBundle, parseBundle, formatExportedAt } from '../agent/handoff/handoff.js';
import type { ChatViewProvider } from '../webview/chatView.js';

export interface HandoffCommandDeps {
  getChatProvider: () => ChatViewProvider | undefined;
}

function defaultFilename(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `sidecar-handoff-${ymd}.json`;
}

export function registerHandoffCommands(context: ExtensionContext, deps: HandoffCommandDeps): void {
  context.subscriptions.push(
    commands.registerCommand('sidecar.handoff.export', async () => {
      const provider = deps.getChatProvider();
      if (!provider) {
        window.showWarningMessage('SideCar: open the chat panel before exporting a handoff.');
        return;
      }

      const messages = provider.state.messages;
      if (messages.length === 0) {
        window.showWarningMessage('SideCar: nothing to export — conversation is empty.');
        return;
      }

      const note = await window.showInputBox({
        title: 'SideCar — Export Handoff',
        prompt: 'Optional note for the recipient (what is done, what is left, gotchas)',
        placeHolder: 'e.g. Auth refactor done. Still need tests for the refresh-token edge case.',
      });
      // note is undefined if the user pressed Escape
      if (note === undefined) return;

      const uri = await window.showSaveDialog({
        title: 'Save SideCar handoff',
        defaultUri: Uri.file(defaultFilename()),
        filters: { 'Handoff files': ['json'] },
      });
      if (!uri) return;

      const bundle = buildBundle(messages, note);
      await fs.writeFile(uri.fsPath, JSON.stringify(bundle, null, 2), 'utf-8');
      window.showInformationMessage(`Handoff saved to ${uri.fsPath}`);
    }),

    commands.registerCommand('sidecar.handoff.import', async () => {
      const provider = deps.getChatProvider();
      if (!provider) {
        window.showWarningMessage('SideCar: open the chat panel before importing a handoff.');
        return;
      }

      const uris = await window.showOpenDialog({
        title: 'Open SideCar handoff',
        filters: { 'Handoff files': ['json'] },
        canSelectMany: false,
      });
      if (!uris || uris.length === 0) return;

      const raw = await fs.readFile(uris[0].fsPath, 'utf-8');
      const result = parseBundle(raw);

      if (!result.ok) {
        window.showErrorMessage(`SideCar: invalid handoff file — ${result.error}`);
        return;
      }

      const { bundle } = result;
      const when = formatExportedAt(bundle.exportedAt);
      const detail = bundle.note ? `Note: ${bundle.note}\nExported: ${when}` : `Exported: ${when}`;

      const pick = await window.showQuickPick(
        [{ label: '$(play) Load handoff', description: bundle.task, detail }, { label: '$(close) Cancel' }],
        { title: 'SideCar — Import Handoff', placeHolder: bundle.task },
      );
      if (!pick || pick.label.includes('Cancel')) return;

      // Reuse session-load logic: abort in-flight run, swap messages, refresh UI
      const state = provider.state;
      state.autoSave();
      state.abort();
      state.cancelCallbacks?.();
      state.abortController = null;
      state.cancelCallbacks = null;
      state.chatGeneration++;
      state.currentSteerDisposer?.();
      state.currentSteerDisposer = null;
      state.currentSteerQueue = null;
      state.postMessage({ command: 'steerQueueUpdate', steerQueue: [], steerEnabled: false });
      state.messages = bundle.messages;
      state.currentSessionId = null;
      state.saveHistory();
      state.postMessage({ command: 'chatCleared' });
      state.postMessage({ command: 'init', messages: state.messages });

      window.showInformationMessage(`Handoff loaded: "${bundle.task}"${bundle.note ? ` — ${bundle.note}` : ''}`);
    }),
  );
}
