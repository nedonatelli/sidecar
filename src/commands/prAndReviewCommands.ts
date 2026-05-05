import { window, workspace, commands, ExtensionContext, StatusBarAlignment, ProgressLocation } from 'vscode';
import { getConfig, isLocalOllama, isKickstand } from '../config/settings.js';
import { SideCarClient } from '../ollama/client.js';
import type { ChatViewProvider } from '../webview/chatView.js';
import { reviewCurrentChanges } from '../review/reviewer.js';
import { summarizePR } from '../review/prSummary.js';
import { generateCommitMessage } from '../review/commitMessage.js';
import { generateSidecarMd } from '../config/sidecarMdGenerator.js';
import { runDraftPullRequest, type DraftPrConfig, type DraftPrUi } from '../review/draftPullRequest.js';
import { analyzeCiFailure, type AnalyzeCiUi } from '../review/analyzeCiFailure.js';
import { reviewPrComments, type PrReviewUi } from '../review/prReview.js';
import { respondToPrComments, type PrRespondUi } from '../review/prRespond.js';
import { postPrReview, type PrPostReviewUi } from '../review/prPostReview.js';
import { markPrReady, checkPrCi, type PrMarkReadyUi, type PrCiUi } from '../review/prLifecycle.js';
import { runPreCommitScan } from '../agent/preCommitScan.js';

export interface PrAndReviewDeps {
  createClient: () => SideCarClient;
  getChatProvider: () => ChatViewProvider | undefined;
}

/**
 * Register code-review, PR workflow, model-picker, and git utility commands.
 * Extracted from extension.ts to keep the entry point under 150 lines.
 */
export function registerPrAndReviewCommands(context: ExtensionContext, deps: PrAndReviewDeps): void {
  const { createClient, getChatProvider } = deps;

  context.subscriptions.push(
    commands.registerCommand('sidecar.reviewChanges', async () => {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: 'SideCar — Reviewing changes',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Collecting diff and running the model...' });
          await reviewCurrentChanges(createClient());
        },
      );
    }),
    commands.registerCommand('sidecar.summarizePR', async () => {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: 'SideCar — Summarizing pull request',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Fetching diff and generating summary...' });
          await summarizePR(createClient());
        },
      );
    }),
    commands.registerCommand('sidecar.pr.create', async () => {
      const wsFolder = workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        window.showErrorMessage('SideCar: Open a workspace before creating a PR.');
        return;
      }
      const cwd = wsFolder.uri.fsPath;
      const prCfg = workspace.getConfiguration('sidecar.pr.create');
      const config: DraftPrConfig = {
        draftByDefault: prCfg.get<boolean>('draftByDefault', true),
        baseBranch: prCfg.get<string>('baseBranch', 'auto') as 'auto' | string,
        template: prCfg.get<string>('template', 'auto') as 'auto' | 'ignore' | string,
      };
      const ui: DraftPrUi = {
        async showInputBox(prompt, value) {
          return window.showInputBox({ prompt, value });
        },
        async showConfirm(message, options) {
          return window.showInformationMessage(message, { modal: true }, ...options);
        },
        showInfo(message) {
          window.showInformationMessage(message);
        },
        showError(message) {
          window.showErrorMessage(message);
        },
        async openPreview(content, title) {
          const doc = await workspace.openTextDocument({ content, language: 'markdown' });
          await window.showTextDocument(doc, { preview: true, preserveFocus: true });
          void title;
        },
      };
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: 'SideCar — Creating draft pull request',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Preparing branch and drafting title + body...' });
          await runDraftPullRequest({ ui, client: createClient(), cwd, config });
        },
      );
    }),
    commands.registerCommand('sidecar.ci.analyze', async () => {
      const wsFolder = workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        window.showErrorMessage('SideCar: Open a workspace before analyzing CI.');
        return;
      }
      const cwd = wsFolder.uri.fsPath;
      const ui: AnalyzeCiUi = {
        showInfo(message) {
          window.showInformationMessage(message);
        },
        showError(message) {
          window.showErrorMessage(message);
        },
        async openPreview(content, title) {
          const doc = await workspace.openTextDocument({ content, language: 'markdown' });
          await window.showTextDocument(doc, { preview: true, preserveFocus: true });
          void title;
        },
        async showConfirm(message, options) {
          return window.showInformationMessage(message, { modal: true }, ...options);
        },
        async sendToAgent(prompt) {
          const chatProvider = getChatProvider();
          if (!chatProvider) {
            throw new Error('SideCar chat view is not initialized yet.');
          }
          chatProvider.injectPrompt(prompt);
        },
      };
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: 'SideCar — Analyzing CI failure',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Fetching workflow runs and logs...' });
          await analyzeCiFailure({ ui, cwd });
        },
      );
    }),
    commands.registerCommand('sidecar.pr.markReady', async () => {
      const wsFolder = workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        window.showErrorMessage('SideCar: Open a workspace before marking a PR ready.');
        return;
      }
      const cwd = wsFolder.uri.fsPath;
      const ui: PrMarkReadyUi = {
        showInfo(message) {
          window.showInformationMessage(message);
        },
        showError(message) {
          window.showErrorMessage(message);
        },
      };
      await markPrReady({ ui, cwd });
    }),
    commands.registerCommand('sidecar.pr.checkCi', async () => {
      const wsFolder = workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        window.showErrorMessage('SideCar: Open a workspace before checking CI status.');
        return;
      }
      const cwd = wsFolder.uri.fsPath;
      const ui: PrCiUi = {
        showInfo(message) {
          window.showInformationMessage(message);
        },
        showError(message) {
          window.showErrorMessage(message);
        },
        async openPreview(content, title) {
          const doc = await workspace.openTextDocument({ content, language: 'markdown' });
          await window.showTextDocument(doc, { preview: true, preserveFocus: true });
          void title;
        },
        async sendToAgent(prompt) {
          const chatProvider = getChatProvider();
          if (!chatProvider) {
            throw new Error('SideCar chat view is not initialized yet.');
          }
          chatProvider.injectPrompt(prompt);
        },
      };
      await checkPrCi({ ui, cwd });
    }),
    commands.registerCommand('sidecar.pr.respond', async () => {
      const wsFolder = workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        window.showErrorMessage('SideCar: Open a workspace before responding to PR comments.');
        return;
      }
      const cwd = wsFolder.uri.fsPath;
      const ui: PrRespondUi = {
        showInfo(message) {
          window.showInformationMessage(message);
        },
        showError(message) {
          window.showErrorMessage(message);
        },
        async sendToAgent(prompt) {
          const chatProvider = getChatProvider();
          if (!chatProvider) {
            throw new Error('SideCar chat view is not initialized yet.');
          }
          chatProvider.injectPrompt(prompt);
        },
      };
      await respondToPrComments({ ui, cwd });
    }),
    commands.registerCommand('sidecar.pr.postReview', async () => {
      const wsFolder = workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        window.showErrorMessage('SideCar: Open a workspace before posting a PR review.');
        return;
      }
      const cwd = wsFolder.uri.fsPath;
      const ui: PrPostReviewUi = {
        showInfo(message) {
          window.showInformationMessage(message);
        },
        showError(message) {
          window.showErrorMessage(message);
        },
        async sendToAgent(prompt) {
          const chatProvider = getChatProvider();
          if (!chatProvider) {
            throw new Error('SideCar chat view is not initialized yet.');
          }
          chatProvider.injectPrompt(prompt);
        },
      };
      await postPrReview({ ui, cwd });
    }),
    commands.registerCommand('sidecar.pr.reviewComments', async () => {
      const wsFolder = workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        window.showErrorMessage('SideCar: Open a workspace before reviewing PR comments.');
        return;
      }
      const cwd = wsFolder.uri.fsPath;
      const ui: PrReviewUi = {
        showInfo(message) {
          window.showInformationMessage(message);
        },
        showError(message) {
          window.showErrorMessage(message);
        },
        async openPreview(content, title) {
          const doc = await workspace.openTextDocument({ content, language: 'markdown' });
          await window.showTextDocument(doc, { preview: true, preserveFocus: true });
          void title;
        },
        async showConfirm(message, options) {
          return window.showInformationMessage(message, { modal: true }, ...options);
        },
        async sendToAgent(prompt) {
          const chatProvider = getChatProvider();
          if (!chatProvider) {
            throw new Error('SideCar chat view is not initialized yet.');
          }
          chatProvider.injectPrompt(prompt);
        },
      };
      await reviewPrComments({ ui, cwd });
    }),
    commands.registerCommand('sidecar.generateCommitMessage', async () => {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: 'SideCar — Generating commit message',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Reading staged changes and drafting...' });
          await generateCommitMessage(createClient());
        },
      );
    }),
    commands.registerCommand('sidecar.generateSidecarMd', async () => {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: 'SideCar — Generating SIDECAR.md',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Reading workspace and drafting...' });
          await generateSidecarMd(createClient());
        },
      );
    }),
    commands.registerCommand('sidecar.scanStaged', async () => {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: 'SideCar — Scanning staged files for secrets',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Reading git staged diff...' });
          await runPreCommitScan();
        },
      );
    }),
    commands.registerCommand('sidecar.discoverModels', async () => {
      const message = window.createStatusBarItem(StatusBarAlignment.Left);
      message.text = '$(sync~spin) SideCar: Discovering available models...';
      message.show();

      try {
        const cfg = getConfig();
        const ollamaUrl = isLocalOllama(cfg.baseUrl) ? cfg.baseUrl : 'http://localhost:11434';
        const kickstandUrl = isKickstand(cfg.baseUrl) ? cfg.baseUrl : 'http://localhost:11435';
        const models = await SideCarClient.discoverAllAvailableModels(ollamaUrl, kickstandUrl);

        if (models.length === 0) {
          window.showInformationMessage('SideCar: No models found. Make sure Ollama or Kickstand is running.');
        } else {
          const modelList = models.map((m) => m.name).join(', ');
          window.showInformationMessage(`SideCar: Discovered ${models.length} models: ${modelList}`);
          console.log(`[SideCar] Discovered models: ${modelList}`);
        }
      } catch (error) {
        window.showErrorMessage(
          `SideCar: Failed to discover models: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        message.dispose();
      }
    }),

    // Keyboard-first model switcher — opens a native QuickPick with the
    // installed models of whichever backend is currently active. Shares
    // its change-model path with the webview dropdown via
    // `ChatViewProvider.setModel` so both surfaces stay consistent.
    commands.registerCommand('sidecar.selectModel', async () => {
      const chatProvider = getChatProvider();
      if (!chatProvider) {
        window.showWarningMessage('SideCar: chat view not ready yet — try again in a moment.');
        return;
      }

      interface ModelQuickPickItem {
        label: string;
        description?: string;
        detail?: string;
        modelName: string;
        needsInstall: boolean;
      }

      const quickPick = window.createQuickPick<ModelQuickPickItem>();
      quickPick.title = 'SideCar — Select Model';
      quickPick.placeholder = 'Loading models...';
      quickPick.busy = true;
      quickPick.show();

      try {
        const client = chatProvider.client;
        const currentModel = getConfig().model;
        const provider = client.getProviderType();
        const libraryModels = await client.listLibraryModels();

        if (libraryModels.length === 0) {
          quickPick.hide();
          const action = await window.showWarningMessage(
            'SideCar: no models found for the active backend.',
            'Switch Backend',
            'Set API Key',
          );
          if (action === 'Switch Backend') await commands.executeCommand('sidecar.switchBackend');
          if (action === 'Set API Key') await commands.executeCommand('sidecar.setApiKey');
          return;
        }

        const installed = libraryModels.filter((m) => m.installed);
        const notInstalled = libraryModels.filter((m) => !m.installed);
        const providerLabel =
          provider === 'ollama'
            ? 'Ollama'
            : provider === 'anthropic'
              ? 'Anthropic'
              : provider === 'openai'
                ? 'OpenAI'
                : 'Kickstand';

        const items: ModelQuickPickItem[] = installed.map((m) => ({
          label: m.name === currentModel ? `$(check) ${m.name}` : m.name,
          description: m.name === currentModel ? `active · ${providerLabel}` : providerLabel,
          modelName: m.name,
          needsInstall: false,
        }));

        if (notInstalled.length > 0) {
          items.push(
            ...notInstalled.map((m) => ({
              label: `$(cloud-download) ${m.name}`,
              description: 'not installed — click to pull via Ollama',
              modelName: m.name,
              needsInstall: true,
            })),
          );
        }

        quickPick.items = items;
        quickPick.busy = false;
        quickPick.placeholder = 'Pick a model, or start typing to filter';
        quickPick.matchOnDescription = true;

        const picked = await new Promise<ModelQuickPickItem | undefined>((resolve) => {
          quickPick.onDidAccept(() => {
            resolve(quickPick.selectedItems[0]);
            quickPick.hide();
          });
          quickPick.onDidHide(() => resolve(undefined));
        });

        if (!picked) return;
        if (picked.needsInstall) {
          await commands.executeCommand('sidecar.chatView.focus');
          window.showInformationMessage(
            `SideCar: ${picked.modelName} is not installed yet. Use the chat view's Install button to pull it.`,
          );
          return;
        }

        if (picked.modelName === currentModel) {
          window.showInformationMessage(`SideCar: ${picked.modelName} is already active.`);
          return;
        }

        await chatProvider.setModel(picked.modelName);
        window.showInformationMessage(`SideCar: switched to ${picked.modelName}.`);
      } catch (err) {
        window.showErrorMessage(`SideCar: Failed to list models: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        quickPick.dispose();
      }
    }),
  );
}
