import { commands, ExtensionContext, workspace } from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from './webview/chatView.js';
import { registerAutoModeCommands } from './commands/autoModeCommands.js';
import { getConfig, initSecrets, initConfigWatcher } from './config/settings.js';
import { createClient } from './ollama/factory.js';
import { registerBackendCommands } from './commands/backendCommands.js';
import { registerPrAndReviewCommands } from './commands/prAndReviewCommands.js';
import { registerSettingsCommands } from './commands/settingsCommands.js';
import { registerAgentCommands } from './commands/agentCommands.js';
import { registerStatusBar } from './ui/statusBar.js';
import { registerSidecarParticipant } from './chat/sidecarParticipant.js';
import { registerLmTools } from './chat/lmTools.js';
import { dispose as disposeDiagnostics } from './agent/sidecarDiagnostics.js';
import { setGrammarsPath } from './parsing/registry.js';
import { disposeShellSession } from './agent/tools.js';
import { initBaseServices } from './activation/baseSetup.js';
import { initWorkspaceIndex } from './activation/workspaceIndexer.js';
import { initCoreServices } from './activation/servicesInit.js';
import { initMcpSetup } from './activation/mcpSetup.js';
import { initWarmup } from './activation/warmup.js';
import { registerEditorFeatures } from './activation/editorFeatures.js';
import { setupChatView } from './activation/chatViewSetup.js';
import { registerArenaCommands } from './activation/arenaSetup.js';
import { registerDepsFeature } from './activation/depsSetup.js';
import { initExecutiveFunctionSetup } from './activation/executiveFunctionSetup.js';
import { initMcpServer } from './activation/mcpServerSetup.js';
import { createSdkApi } from './sdk/api.js';
import { loadRepoPolicy, setActivePolicy } from './agent/policy/policyLoader.js';
import { registerHandoffCommands } from './commands/handoffCommands.js';

let chatProvider: ChatViewProvider | undefined;

export function activate(context: ExtensionContext) {
  console.log('SideCar extension activating...');

  // Set grammars path for tree-sitter (lazy-loaded on first parse)
  const grammarsPath = path.join(context.extensionPath, 'grammars');
  setGrammarsPath(grammarsPath);

  // Register config-cache invalidation listener (disposable, tied to extension lifetime).
  initConfigWatcher(context);

  // Initialize SecretStorage and migrate any plaintext API keys.
  // Fire-and-forget: subsequent getConfig() calls pick up the cached secrets.
  initSecrets(context).catch((err) => {
    console.warn('[SideCar] Failed to initialize secrets:', err);
  });

  // Load repo-level policy from .sidecar/policy.json (restrictions-only, non-fatal).
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    loadRepoPolicy(workspaceRoot)
      .then((policy) => setActivePolicy(policy))
      .catch(() => {});
  }

  // Read config once upfront for status bar display
  const config = getConfig();

  const { terminalManager, proposedContentProvider, agentLogger, mcpManager } = initBaseServices(context, config);

  initMcpSetup(context, mcpManager);

  const { sidecarDir, skillLoader, workspaceIndex, symbolIndexer } = initCoreServices(context);
  initWorkspaceIndex(context, workspaceIndex, symbolIndexer, sidecarDir, config);
  initWarmup(config);

  chatProvider = setupChatView(context, {
    terminalManager,
    proposedContentProvider,
    agentLogger,
    mcpManager,
    workspaceIndex,
    sidecarDir,
    skillLoader,
  });

  registerSettingsCommands(context, {
    getChatProvider: () => chatProvider,
    getSkillLoader: () => skillLoader,
  });

  registerPrAndReviewCommands(context, {
    createClient,
    getChatProvider: () => chatProvider,
  });

  registerEditorFeatures(context, config, {
    getChatProvider: () => chatProvider,
    createClient,
    agentLogger,
    mcpManager,
    symbolIndexer,
    proposedContentProvider,
  });

  const autoModeStatusBar = registerAutoModeCommands(context, {
    createClient,
    getMcpManager: () => mcpManager,
    getAgentLogger: () => agentLogger,
    getSidecarDir: () => sidecarDir,
    getChatProvider: () => chatProvider,
  });
  context.subscriptions.push(autoModeStatusBar);

  registerStatusBar(context, { getChatProvider: () => chatProvider });
  context.subscriptions.push(disposeDiagnostics());
  registerAgentCommands(context, context.extension.id, { createClient, getChatProvider: () => chatProvider });
  registerHandoffCommands(context, { getChatProvider: () => chatProvider });
  registerBackendCommands(context, () => chatProvider!.client);
  registerSidecarParticipant(context, () => chatProvider!.client);
  registerLmTools(context);
  registerArenaCommands(context, createClient, sidecarDir);
  registerDepsFeature(context);
  initExecutiveFunctionSetup(context, sidecarDir, () => chatProvider);
  void initMcpServer(context);

  // First-install auto-open. Gated behind a globalState flag so
  // existing users and every subsequent launch skip it. Fires after a
  // short delay so it doesn't compete with VS Code's own Welcome page
  // during workbench startup — that race has been known to leave the
  // walkthrough stuck behind a blank Welcome tab.
  const WALKTHROUGH_SEEN_KEY = 'sidecar.walkthroughSeen';
  if (!context.globalState.get<boolean>(WALKTHROUGH_SEEN_KEY, false)) {
    setTimeout(() => {
      commands.executeCommand(
        'workbench.action.openWalkthrough',
        `${context.extension.id}#sidecar.gettingStarted`,
        false,
      );
      void context.globalState.update(WALKTHROUGH_SEEN_KEY, true);
    }, 1500);
  }

  console.log('SideCar extension activated');

  // Return the public SDK API so third-party extensions can register tools
  // and hooks via `vscode.extensions.getExtension('nedonatelli.sidecar')?.exports`.
  const pkg = context.extension?.packageJSON as { version?: string } | undefined;
  return createSdkApi(context, pkg?.version ?? '0.0.0');
}

export function deactivate() {
  chatProvider?.autoSave();
  chatProvider?.abort();
  disposeShellSession();
}
