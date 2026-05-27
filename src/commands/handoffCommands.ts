import { window, Uri, ExtensionContext, commands } from 'vscode';
import * as fs from 'fs/promises';
import { buildBundle, parseBundle, formatExportedAt, type HandoffBundle } from '../agent/handoff/handoff.js';
import type { ChatMessage } from '../ollama/types.js';
import type { ChatViewProvider } from '../webview/chatView.js';
import type { ExtensionMessage } from '../webview/chatWebview.js';

export interface HandoffCommandDeps {
  getChatProvider: () => ChatViewProvider | undefined;
}

/**
 * Minimal UI surface for handoff commands — real shim in production,
 * injectable fake in tests (same pattern as AuditReviewUi).
 */
export interface HandoffCommandUi {
  showWarning(msg: string): void;
  showInfo(msg: string): void;
  showError(msg: string): void;
  promptNote(): Promise<string | undefined>;
  promptSaveUri(defaultName: string): Promise<Uri | undefined>;
  promptOpenUri(): Promise<Uri[] | undefined>;
  showBundlePreview(bundle: HandoffBundle): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
}

/**
 * State surface needed for session surgery on import. Structural subset
 * of ChatState so tests can provide a plain object without VS Code deps.
 */
export interface ImportableState {
  messages: ChatMessage[];
  autoSave(): void;
  abort(): void;
  cancelCallbacks: (() => void) | null;
  abortController: unknown;
  chatGeneration: number;
  currentSteerDisposer: (() => void) | null;
  currentSteerQueue: unknown;
  currentSessionId: unknown;
  postMessage(msg: ExtensionMessage): void;
  saveHistory(): void;
}

export async function runExportHandoff(messages: ChatMessage[], ui: HandoffCommandUi): Promise<void> {
  if (messages.length === 0) {
    ui.showWarning('SideCar: nothing to export — conversation is empty.');
    return;
  }

  const note = await ui.promptNote();
  if (note === undefined) return;

  const uri = await ui.promptSaveUri(defaultFilename());
  if (!uri) return;

  const bundle = buildBundle(messages, note);
  await ui.writeFile(uri.fsPath, JSON.stringify(bundle, null, 2));
  ui.showInfo(`Handoff saved to ${uri.fsPath}`);
}

export async function runImportHandoff(state: ImportableState, ui: HandoffCommandUi): Promise<void> {
  const uris = await ui.promptOpenUri();
  if (!uris || uris.length === 0) return;

  const raw = await ui.readFile(uris[0].fsPath);
  const result = parseBundle(raw);

  if (!result.ok) {
    ui.showError(`SideCar: invalid handoff file — ${result.error}`);
    return;
  }

  const { bundle } = result;
  const ok = await ui.showBundlePreview(bundle);
  if (!ok) return;

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

  ui.showInfo(`Handoff loaded: "${bundle.task}"${bundle.note ? ` — ${bundle.note}` : ''}`);
}

function defaultFilename(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `sidecar-handoff-${ymd}.json`;
}

function createDefaultHandoffUi(): HandoffCommandUi {
  return {
    showWarning(msg) {
      void window.showWarningMessage(msg);
    },
    showInfo(msg) {
      void window.showInformationMessage(msg);
    },
    showError(msg) {
      void window.showErrorMessage(msg);
    },
    async promptNote() {
      return window.showInputBox({
        title: 'SideCar — Export Handoff',
        prompt: 'Optional note for the recipient (what is done, what is left, gotchas)',
        placeHolder: 'e.g. Auth refactor done. Still need tests for the refresh-token edge case.',
      });
    },
    async promptSaveUri(defaultName) {
      return window.showSaveDialog({
        title: 'Save SideCar handoff',
        defaultUri: Uri.file(defaultName),
        filters: { 'Handoff files': ['json'] },
      });
    },
    async promptOpenUri() {
      return window.showOpenDialog({
        title: 'Open SideCar handoff',
        filters: { 'Handoff files': ['json'] },
        canSelectMany: false,
      });
    },
    async showBundlePreview(bundle) {
      const when = formatExportedAt(bundle.exportedAt);
      const detail = bundle.note ? `Note: ${bundle.note}\nExported: ${when}` : `Exported: ${when}`;
      const pick = await window.showQuickPick(
        [{ label: '$(play) Load handoff', description: bundle.task, detail }, { label: '$(close) Cancel' }],
        { title: 'SideCar — Import Handoff', placeHolder: bundle.task },
      );
      return !!pick && !pick.label.includes('Cancel');
    },
    async writeFile(path, content) {
      await fs.writeFile(path, content, 'utf-8');
    },
    async readFile(path) {
      return fs.readFile(path, 'utf-8');
    },
  };
}

export function registerHandoffCommands(context: ExtensionContext, deps: HandoffCommandDeps): void {
  const ui = createDefaultHandoffUi();

  context.subscriptions.push(
    commands.registerCommand('sidecar.handoff.export', async () => {
      const provider = deps.getChatProvider();
      if (!provider) {
        void window.showWarningMessage('SideCar: open the chat panel before exporting a handoff.');
        return;
      }
      await runExportHandoff(provider.state.messages, ui);
    }),

    commands.registerCommand('sidecar.handoff.import', async () => {
      const provider = deps.getChatProvider();
      if (!provider) {
        void window.showWarningMessage('SideCar: open the chat panel before importing a handoff.');
        return;
      }
      await runImportHandoff(provider.state, ui);
    }),
  );
}
