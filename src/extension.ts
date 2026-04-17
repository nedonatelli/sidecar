import {
  window,
  workspace,
  languages,
  commands,
  ExtensionContext,
  Disposable,
  StatusBarAlignment,
  ThemeColor,
  MarkdownString,
  ProgressLocation,
} from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from './webview/chatView.js';
import { TerminalManager } from './terminal/manager.js';
import { TerminalErrorWatcher } from './terminal/errorWatcher.js';
import { registerJsDocSync } from './docs/jsDocSyncProvider.js';
import { registerReadmeSync } from './docs/readmeSyncProvider.js';
import { registerReviewPanel } from './agent/reviewPanel.js';
import { SideCarCompletionProvider } from './completions/provider.js';
import {
  getConfig,
  isLocalOllama,
  isKickstand,
  detectProvider,
  initSecrets,
  setApiKeySecret,
  setHuggingFaceToken,
  clearHuggingFaceToken,
} from './config/settings.js';
import { checkWorkspaceConfigTrust } from './config/workspaceTrust.js';
import { createClient } from './ollama/factory.js';
import { SideCarClient } from './ollama/client.js';
import { spendTracker, formatUsd } from './ollama/spendTracker.js';
import { healthStatus, type HealthSnapshot } from './ollama/healthStatus.js';
import { dispose as disposeDiagnostics, clearAll as clearSidecarDiagnostics } from './agent/sidecarDiagnostics.js';
import { ProposedContentProvider } from './edits/proposedContentProvider.js';
import { AgentLogger } from './agent/logger.js';
import { MCPManager, loadProjectMcpConfig, mergeMcpConfigs } from './agent/mcpManager.js';
import { Scheduler } from './agent/scheduler.js';
import { handleInlineChat } from './inline/inlineChatProvider.js';
import { setGrammarsPath } from './parsing/registry.js';
import { reviewCurrentChanges } from './review/reviewer.js';
import { summarizePR } from './review/prSummary.js';
import { generateCommitMessage } from './review/commitMessage.js';
import { EventHookManager } from './agent/eventHooks.js';
import { WorkspaceIndex } from './config/workspaceIndex.js';
import { SidecarDir } from './config/sidecarDir.js';
import { SymbolIndexer } from './config/symbolIndexer.js';
import { SkillLoader } from './agent/skillLoader.js';
import { getFilePatterns } from './config/workspace.js';
import { runPreCommitScan } from './agent/preCommitScan.js';
import { disposeShellSession, setSymbolGraph, setSymbolEmbeddings, initCustomToolsTrust } from './agent/tools.js';
import { disposeSidecarMdWatcher } from './webview/handlers/chatHandlers.js';
import { InlineEditProvider } from './edits/inlineEditProvider.js';
import { SidecarCodeActionProvider } from './edits/sidecarCodeActionProvider.js';
import { PendingEditDecorationProvider } from './edits/pendingEditDecorationProvider.js';

let chatProvider: ChatViewProvider | undefined;

export function activate(context: ExtensionContext) {
  console.log('SideCar extension activating...');

  // Set grammars path for tree-sitter (lazy-loaded on first parse)
  const grammarsPath = path.join(context.extensionPath, 'grammars');
  setGrammarsPath(grammarsPath);

  // Initialize SecretStorage and migrate any plaintext API keys.
  // Fire-and-forget: subsequent getConfig() calls pick up the cached secrets.
  initSecrets(context).catch((err) => {
    console.warn('[SideCar] Failed to initialize secrets:', err);
  });

  // Read config once upfront for status bar display
  const config = getConfig();
  let cachedModel = config.model;
  let cachedBaseUrl = config.baseUrl;

  const terminalManager = new TerminalManager();
  context.subscriptions.push(terminalManager);

  const proposedContentProvider = new ProposedContentProvider();
  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider('sidecar-proposed', proposedContentProvider),
  );

  const agentLogger = new AgentLogger();
  context.subscriptions.push(agentLogger);

  const mcpManager = new MCPManager();
  context.subscriptions.push(mcpManager);

  // Defer MCP connection — run after activation completes so it doesn't block startup
  // Merge configs from VS Code settings + .mcp.json project file
  // Warn if MCP configs come from workspace settings (supply-chain risk: they spawn processes)
  const connectMcp = async () => {
    try {
      const settingsServers = getConfig().mcpServers;
      const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
      const projectServers = workspaceRoot ? await loadProjectMcpConfig(workspaceRoot) : {};
      const allServers = mergeMcpConfigs(projectServers, settingsServers);

      if (Object.keys(allServers).length === 0) return;

      const trust = await checkWorkspaceConfigTrust(
        'mcpServers',
        'SideCar: This workspace defines MCP server configs that may spawn external processes. Only trust these from repositories you control.',
      );
      if (trust === 'blocked') {
        console.log('[SideCar] Workspace MCP servers blocked by user');
        return;
      }
      await mcpManager.connect(allServers);
    } catch (err) {
      console.error('[SideCar] Failed to connect MCP servers:', err);
    }
  };

  if (Object.keys(config.mcpServers).length > 0 || workspace.workspaceFolders?.length) {
    setImmediate(connectMcp);
  }

  // Reconnect MCP servers when settings change
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.mcpServers')) {
        connectMcp().catch((err) => console.error('[SideCar] Failed to reconnect MCP servers:', err));
      }
    }),
  );

  // Initialize .sidecar/ project directory
  const sidecarDir = new SidecarDir();
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    sidecarDir.initialize().then(
      async (ok) => {
        if (!ok) return;
        console.log('[SideCar] .sidecar/ directory ready');
        // Audit Mode v0.61 a.3: wire persistence + check for a
        // prior-session buffer. If anything's there, prompt the user
        // before re-exposing the entries — they may not remember the
        // previous run and silently re-staging its writes could be a
        // surprise on the next accept-all.
        await initAuditBufferRecovery();
      },
      (err) => console.warn('[SideCar] .sidecar/ init failed:', err),
    );
  }

  // Load built-in + user + project skills
  const skillLoader = new SkillLoader();
  skillLoader.setBuiltinPath(path.join(context.extensionPath, 'skills'));
  skillLoader.initialize().catch((err) => console.warn('[SideCar] Skill loading failed:', err));

  const workspaceIndex = new WorkspaceIndex();
  workspaceIndex.setSidecarDir(sidecarDir);
  context.subscriptions.push(workspaceIndex);

  // Initialize symbol graph indexer
  const symbolIndexer = new SymbolIndexer(sidecarDir);
  context.subscriptions.push(symbolIndexer);

  // Initialize workspace index in the background with progress indicator
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    const indexStatus = window.createStatusBarItem(StatusBarAlignment.Left, 0);
    indexStatus.text = '$(sync~spin) SideCar: Indexing workspace...';
    indexStatus.show();
    context.subscriptions.push(indexStatus);
    workspaceIndex
      .initialize(getFilePatterns())
      .then(async () => {
        const count = workspaceIndex.getFileCount();
        console.log(`[SideCar] Workspace indexed: ${count} files`);
        indexStatus.text = `$(check) SideCar: ${count} files indexed`;
        setTimeout(() => indexStatus.dispose(), 5000);

        // Build symbol graph after workspace index is ready
        symbolIndexer
          .initialize(getFilePatterns())
          .then(() => {
            const symCount = symbolIndexer.getGraph().symbolCount();
            console.log(`[SideCar] Symbol graph built: ${symCount} symbols`);
            workspaceIndex.setSymbolIndexer(symbolIndexer);
            setSymbolGraph(symbolIndexer.getGraph());
          })
          .catch((err) => console.warn('[SideCar] Symbol graph build failed:', err));

        // Build semantic embedding index (background, non-blocking)
        if (config.enableSemanticSearch) {
          const { EmbeddingIndex } = await import('./config/embeddingIndex.js');
          const embeddingIndex = new EmbeddingIndex(sidecarDir);
          context.subscriptions.push(embeddingIndex);
          embeddingIndex
            .initialize()
            .then(() => {
              workspaceIndex.setEmbeddingIndex(embeddingIndex);
              console.log(`[SideCar] Embedding index ready: ${embeddingIndex.getCount()} cached vectors`);
              // Queue initial embedding for all indexed files
              for (const file of workspaceIndex.getFiles()) {
                embeddingIndex.queuePath(file.relativePath, workspace.workspaceFolders![0].uri.fsPath);
              }
            })
            .catch((err) => console.warn('[SideCar] Embedding index failed:', err.message || err));
        }

        // Project Knowledge Index — symbol-level semantic index
        // (v0.61 b.2). Opt-in via `sidecar.projectKnowledge.enabled`
        // while the feature arc builds out. Wires onto the symbol
        // indexer so every parsed file feeds per-symbol bodies into
        // the embedding queue.
        if (config.projectKnowledgeEnabled) {
          const { SymbolEmbeddingIndex } = await import('./config/symbolEmbeddingIndex.js');
          // v0.62 c.2: honor the backend setting. Only `flat` is
          // shipped today; `lance` is reserved for a future release
          // so selecting it surfaces a one-time warning and falls
          // through to the flat backend. The warning is non-modal
          // because the feature is already opt-in — users who
          // explicitly typed `lance` in settings have already
          // accepted the preview surface.
          if (config.projectKnowledgeBackend === 'lance') {
            console.warn(
              '[SideCar] sidecar.projectKnowledge.backend=lance is reserved for a future release; using `flat` instead.',
            );
            void window.showWarningMessage(
              'SideCar: Project Knowledge backend "lance" is not available in this build — using "flat" instead.',
            );
          }
          const symbolEmbeddings = new SymbolEmbeddingIndex(sidecarDir);
          context.subscriptions.push(symbolEmbeddings);
          symbolEmbeddings
            .initialize()
            .then(async () => {
              symbolIndexer.setSymbolEmbeddings(symbolEmbeddings, config.projectKnowledgeMaxSymbolsPerFile);
              // Expose the index to the tool registry so
              // `project_knowledge_search` has something to query.
              setSymbolEmbeddings(symbolEmbeddings);
              // v0.62 c.1: also expose to the WorkspaceIndex so
              // SemanticRetriever prefers symbol-level hits over the
              // legacy file-level path.
              workspaceIndex.setSymbolEmbeddings(symbolEmbeddings);
              // v0.62 d.3: wire the Merkle tree for descent-based
              // query pruning. Architecturally coupled to PKI per
              // the ROADMAP but kept on a separate toggle so users
              // can debug retrieval regressions by isolating Merkle.
              if (config.merkleIndexEnabled) {
                const { MerkleTree } = await import('./config/merkleTree.js');
                const merkleTree = new MerkleTree();
                symbolEmbeddings.setMerkleTree(merkleTree);
                console.log(
                  `[SideCar] Merkle tree wired: rootHash=${symbolEmbeddings.getMerkleRoot().slice(0, 8) || '(empty)'}`,
                );
              }
              console.log(
                `[SideCar] Symbol embedding index ready: ${symbolEmbeddings.getCount()} cached symbol vectors`,
              );
              // Re-queue every currently-indexed file so symbols that
              // landed in the graph before the embedder was wired get
              // a chance to embed on startup. Subsequent file edits
              // flow through the normal update path.
              for (const file of workspaceIndex.getFiles()) {
                symbolIndexer.queueUpdate(file.relativePath);
              }
            })
            .catch((err) => console.warn('[SideCar] Symbol embedding index failed:', err?.message || err));
        }
      })
      .catch((err) => {
        console.error('[SideCar] Workspace indexing failed:', err);
        indexStatus.text = '$(warning) SideCar: Indexing failed';
        setTimeout(() => indexStatus.dispose(), 5000);
      });
  }

  // Pre-warm: load the configured model into Ollama's memory so the first
  // chat message doesn't wait for a cold start.  Runs in the background and
  // fails silently — it's a best-effort optimisation.
  if (isLocalOllama(config.baseUrl)) {
    setImmediate(() => {
      const warmUrl = `${config.baseUrl}/api/generate`;
      fetch(warmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, prompt: '', keep_alive: '10m' }),
      })
        .then((res) => {
          if (res.ok) {
            console.log(`[SideCar] Pre-warmed model: ${config.model}`);
          } else {
            console.warn(`[SideCar] Pre-warm failed (${res.status}) for ${config.model}`);
          }
        })
        .catch((err) => {
          console.warn('[SideCar] Pre-warm skipped — Ollama may not be running:', err.message);
        });
    });
  }

  // Discover available models on startup, but only when using local backends.
  // Remote-only providers (anthropic, openai) don't benefit from probing localhost.
  const provider = detectProvider(config.baseUrl, config.provider);
  if (provider === 'ollama' || provider === 'kickstand') {
    setImmediate(() => {
      const ollamaUrl = isLocalOllama(config.baseUrl) ? config.baseUrl : 'http://localhost:11434';
      const kickstandUrl = isKickstand(config.baseUrl) ? config.baseUrl : 'http://localhost:11435';
      SideCarClient.discoverAllAvailableModels(ollamaUrl, kickstandUrl)
        .then((models) => {
          if (models.length > 0) {
            const modelNames = models.map((m) => m.name).join(', ');
            console.log(`[SideCar] Discovered ${models.length} available models: ${modelNames}`);
          } else {
            console.log('[SideCar] No models discovered from Ollama or Kickstand');
          }
        })
        .catch((err) => {
          console.warn('[SideCar] Model discovery failed:', err.message);
        });
    });
  }

  // Inline edit provider — "tab to apply" ghost text for agent-proposed edits
  const inlineEditProvider = new InlineEditProvider();
  context.subscriptions.push(inlineEditProvider);
  context.subscriptions.push(languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineEditProvider));

  // Register the accepted callback command (fires after VS Code applies the inline completion)
  context.subscriptions.push(
    commands.registerCommand('sidecar.onInlineEditAccepted', () => {
      inlineEditProvider.accept();
    }),
  );

  chatProvider = new ChatViewProvider(
    context,
    terminalManager,
    proposedContentProvider,
    agentLogger,
    mcpManager,
    workspaceIndex,
    sidecarDir,
    skillLoader,
    inlineEditProvider,
  );
  context.subscriptions.push(
    window.registerWebviewViewProvider('sidecar.chatView', chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );

  // Register the JSDoc staleness checker. On save of a TS/JS file, finds
  // @param tags that no longer match the function signature and surfaces
  // them as diagnostics with Add / Remove quick-fix actions.
  context.subscriptions.push(registerJsDocSync());

  // Register the README sync checker. Watches README.md and every src/
  // source file; on save of either, re-checks the README's fenced code
  // blocks for calls whose arg count no longer matches the current export.
  context.subscriptions.push(registerReadmeSync());

  // Register the agent diff review panel. Shares the PendingEditStore with
  // the chat view so files queued during review-mode agent runs show up
  // here for the user to accept or discard before they hit disk.
  context.subscriptions.push(registerReviewPanel(context, chatProvider.pendingEditStore, proposedContentProvider));

  // File decoration provider — puts a "P" badge on every file with
  // pending agent edits in the Explorer, editor tabs, and any other
  // FileDecoration consumer. Rolls up to parent folders the same way
  // git's M/A/D indicators do.
  const pendingDecorations = new PendingEditDecorationProvider(chatProvider.pendingEditStore);
  context.subscriptions.push(window.registerFileDecorationProvider(pendingDecorations), pendingDecorations);

  // Watch the integrated terminal for failed commands and offer to diagnose
  // them in the chat. Skips SideCar's own terminal to avoid feedback loops.
  const terminalErrorWatcher = new TerminalErrorWatcher({
    enabled: () => getConfig().terminalErrorInterception,
    ignoredTerminalNames: new Set(['SideCar']),
    onError: async (event) => {
      const truncated = event.commandLine.length > 60 ? event.commandLine.slice(0, 57) + '...' : event.commandLine;
      const choice = await window.showWarningMessage(
        `Command failed (exit ${event.exitCode}): ${truncated}`,
        'Diagnose in chat',
        'Ignore',
      );
      if (choice === 'Diagnose in chat') {
        await chatProvider?.diagnoseTerminalError(event);
      }
    },
  });
  context.subscriptions.push(terminalErrorWatcher);

  // Keyboard shortcuts
  context.subscriptions.push(
    commands.registerCommand('sidecar.toggleChat', () => {
      commands.executeCommand('sidecar.chatView.focus');
    }),
    commands.registerCommand('sidecar.clearChat', () => {
      chatProvider?.clearChat();
    }),
    commands.registerCommand('sidecar.undoChanges', () => {
      chatProvider?.undoChanges();
    }),
    commands.registerCommand('sidecar.exportChat', () => {
      chatProvider?.exportChat();
    }),
    commands.registerCommand('sidecar.setApiKey', async () => {
      const value = await window.showInputBox({
        prompt: 'Enter your API key (stored securely in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      const trimmed = value.trim();
      if (!trimmed) {
        window.showWarningMessage('SideCar API key was empty — not saved.');
        return;
      }

      // If the user is currently on a profile with a dedicated secret slot,
      // store it there too so switching profiles later restores the right key.
      const { detectActiveProfile, setProfileApiKey, getConfig: readConfig } = await import('./config/settings.js');
      const activeProfile = detectActiveProfile(readConfig().baseUrl);
      if (activeProfile && activeProfile.secretKey) {
        await setProfileApiKey(activeProfile, trimmed);
        window.showInformationMessage(`SideCar API key saved for ${activeProfile.name}.`);
      } else {
        await setApiKeySecret(trimmed);
        window.showInformationMessage('SideCar API key saved to SecretStorage.');
      }
      chatProvider?.reloadModels();
    }),
    commands.registerCommand('sidecar.setHuggingFaceToken', async () => {
      const pick = await window.showQuickPick(
        [
          { label: 'Set / Update token', id: 'set' },
          { label: 'Clear stored token', id: 'clear' },
        ],
        {
          title: 'SideCar: HuggingFace access token',
          placeHolder: 'Used to download gated Safetensors models (Llama, Gemma, etc.)',
        },
      );
      if (!pick) return;
      if (pick.id === 'clear') {
        await clearHuggingFaceToken();
        window.showInformationMessage('HuggingFace token removed.');
        return;
      }
      const value = await window.showInputBox({
        prompt: 'Paste your HuggingFace access token (https://huggingface.co/settings/tokens)',
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      const trimmed = value.trim();
      if (!trimmed) {
        window.showWarningMessage('HuggingFace token was empty — not saved.');
        return;
      }
      await setHuggingFaceToken(trimmed);
      window.showInformationMessage('HuggingFace token saved to SecretStorage.');
    }),
    commands.registerCommand('sidecar.switchBackend', async (profileId?: unknown) => {
      const { BUILT_IN_BACKEND_PROFILES, applyBackendProfile } = await import('./config/settings.js');
      // Runtime guard: the command is invocable from the webview, a
      // markdown hover link, the command palette, and other commands.
      // Only a string is a meaningful profile ID; anything else means
      // "show the picker". Without the guard a stray {profileId: 42}
      // silently drops through the `find(...)` call and returns undefined.
      const requestedId = typeof profileId === 'string' ? profileId : undefined;
      let profile = requestedId ? BUILT_IN_BACKEND_PROFILES.find((p) => p.id === requestedId) : undefined;
      if (!profile) {
        const pick = await window.showQuickPick(
          BUILT_IN_BACKEND_PROFILES.map((p) => ({
            label: p.name,
            description: p.description,
            detail: p.baseUrl,
            id: p.id,
          })),
          { title: 'Switch SideCar backend', placeHolder: 'Choose a backend profile' },
        );
        if (!pick) return;
        profile = BUILT_IN_BACKEND_PROFILES.find((p) => p.id === pick.id);
      }
      if (!profile) return;
      const result = await applyBackendProfile(profile);
      if (result.status === 'missing-key') {
        const action = await window.showWarningMessage(result.message, 'Set API Key');
        if (action === 'Set API Key') {
          commands.executeCommand('sidecar.setApiKey');
        }
      } else {
        window.showInformationMessage(result.message);
      }
      chatProvider?.reloadModels();

      // Reconcile the active model against what the new backend actually
      // has. The profile's defaultModel may be empty or stale — pick the
      // first available model so the user isn't stuck on a phantom name.
      if (chatProvider) {
        try {
          const models = await chatProvider.client.listInstalledModels();
          const cfg = getConfig();
          const hit = models.some(
            (m: { name: string }) => m.name === cfg.model || m.name.split(':')[0] === cfg.model.split(':')[0],
          );
          if (!hit && models.length > 0) {
            const best = models[0].name;
            await workspace.getConfiguration('sidecar').update('model', best, true);
            await chatProvider.setModel(best);
          } else if (!hit && models.length === 0) {
            await workspace.getConfiguration('sidecar').update('model', '', true);
            const providerType = chatProvider.client.getProviderType();
            const hint =
              providerType === 'kickstand'
                ? 'Paste a HuggingFace repo name (e.g. `Qwen/Qwen2.5-0.5B-Instruct-GGUF`) into the model input to pull and load it.'
                : providerType === 'ollama'
                  ? 'Run `ollama pull <model>` from the terminal or paste a model name into the model input.'
                  : 'Enter a model name in the model input to get started.';
            window.showInformationMessage(`SideCar: No models available on ${profile!.name}. ${hint}`);
          }
        } catch {
          // Backend unreachable — loadModels will surface a connection error
        }
      }
    }),
  );

  // Code actions (right-click menu + lightbulb). The command accepts
  // optional args from the CodeActionProvider so that a lightbulb click
  // on a diagnostic can forward the exact range + diagnostic message,
  // while plain keyboard / context-menu invocations still fall back to
  // reading the active editor's selection.
  interface CodeActionArgs {
    code?: string;
    fileName?: string;
    diagnostic?: string;
  }
  function registerCodeAction(commandId: string, action: string) {
    return commands.registerCommand(commandId, (args?: CodeActionArgs) => {
      let code = args?.code;
      let fileName = args?.fileName;
      const diagnostic = args?.diagnostic;

      if (!code || !fileName) {
        const editor = window.activeTextEditor;
        if (!editor) return;
        const fallbackCode = editor.document.getText(editor.selection);
        if (!fallbackCode) return;
        code = fallbackCode;
        fileName = path.basename(editor.document.fileName);
      }

      commands.executeCommand('sidecar.chatView.focus');
      chatProvider?.sendCodeAction(action, code, fileName, diagnostic);
    });
  }

  context.subscriptions.push(
    registerCodeAction('sidecar.explainSelection', 'Explain'),
    registerCodeAction('sidecar.fixSelection', 'Fix'),
    registerCodeAction('sidecar.refactorSelection', 'Refactor'),
  );

  // Lightbulb provider — registers SideCar as a CodeActionProvider for
  // every language, so its Fix/Explain/Refactor options show up in the
  // native 💡 menu alongside other providers instead of being hidden
  // behind our custom editor context menu.
  context.subscriptions.push(
    languages.registerCodeActionsProvider({ scheme: 'file' }, new SidecarCodeActionProvider(), {
      providedCodeActionKinds: SidecarCodeActionProvider.providedCodeActionKinds,
    }),
  );

  // Inline chat (Cmd+I)
  context.subscriptions.push(
    commands.registerCommand('sidecar.inlineChat', () => {
      handleInlineChat(createClient());
    }),
  );

  // Code review + PR summary. Each wraps its async work in a native
  // VS Code progress notification so a user who invoked the command
  // from the palette (and may not have the chat view open) gets a
  // visible spinner and title until the operation completes. Errors
  // thrown by the underlying function close the progress toast
  // automatically and propagate to VS Code's default error handling.
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

        // Installed first, then library (Ollama only), with the current
        // model flagged so users can see at a glance what's active.
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
          // Hand off to the existing install path in the webview so the
          // user gets the streaming progress bar they already know.
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

  // Event-based hooks (file save, create, delete). The audit-log
  // provider is a lazy getter so EventHookManager can fetch the
  // *current* session's AuditLog each time a hook fires — ChatState
  // can be recreated, so a reference captured at construction would
  // go stale.
  const eventHookManager = new EventHookManager(agentLogger, () => chatProvider?.getAuditLog() ?? null);
  const eventHooks = config.eventHooks;
  if (eventHooks.onSave || eventHooks.onCreate || eventHooks.onDelete) {
    eventHookManager.start(eventHooks);
  }
  context.subscriptions.push(eventHookManager);

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.eventHooks')) {
        eventHookManager.stop();
        const hooks = getConfig().eventHooks;
        if (hooks.onSave || hooks.onCreate || hooks.onDelete) {
          eventHookManager.start(hooks);
        }
      }
    }),
  );

  // Inline completions — only register when enabled (lazy init)
  let completionDisposable: Disposable | null = null;

  function registerCompletions() {
    completionDisposable?.dispose();
    completionDisposable = null;

    if (!config.enableInlineCompletions) return;

    const completionModel = config.completionModel || cachedModel;
    const client = createClient(completionModel);
    const completionProvider = new SideCarCompletionProvider(
      client,
      config.completionMaxTokens,
      config.completionDebounceMs,
    );

    completionDisposable = languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider);
    context.subscriptions.push(completionDisposable);
  }

  // Only set up completions at startup if actually enabled
  if (config.enableInlineCompletions) {
    registerCompletions();
  }

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('sidecar.enableInlineCompletions') ||
        e.affectsConfiguration('sidecar.completionModel') ||
        e.affectsConfiguration('sidecar.completionMaxTokens') ||
        e.affectsConfiguration('sidecar.completionDebounceMs')
      ) {
        registerCompletions();
      }
    }),
  );

  // Scheduled tasks — gated on workspace trust the same way MCP servers,
  // hooks, toolPermissions, and SIDECAR.md are. Without this check a
  // hostile `.vscode/settings.json` that sets `sidecar.scheduledTasks`
  // could auto-start an autonomous agent loop on a timer just by opening
  // the repo, since `runTask` dispatches `runAgentLoop` with
  // `approvalMode: 'autonomous'`.
  const scheduler = new Scheduler(agentLogger, mcpManager);
  context.subscriptions.push(scheduler);

  const startSchedulerGated = async (tasks: typeof config.scheduledTasks): Promise<void> => {
    if (tasks.length === 0) return;
    const trust = await checkWorkspaceConfigTrust(
      'scheduledTasks',
      'SideCar: This workspace defines scheduled tasks that will run an autonomous agent loop on a timer. Only trust these from repositories you control.',
    );
    if (trust === 'blocked') {
      console.log('[SideCar] Workspace scheduledTasks blocked by user');
      return;
    }
    scheduler.start(tasks);
  };

  if (config.scheduledTasks.length > 0) {
    void startSchedulerGated(config.scheduledTasks);
  }

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.scheduledTasks')) {
        scheduler.stop();
        void startSchedulerGated(getConfig().scheduledTasks);
      }
      if (e.affectsConfiguration('sidecar.customTools')) {
        void initCustomToolsTrust();
      }
    }),
  );

  // Prompt for trust once at activation if the workspace declares custom
  // tools. Done fire-and-forget because the sync tool-registry path treats
  // "not yet checked" as trusted when no workspace-level value exists.
  void initCustomToolsTrust();

  // Status bar — use cached config values. Text, icon, and background
  // colour all reflect the current health of the active backend so
  // the user can tell at a glance whether SideCar is working.
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right, 100);
  statusBar.command = 'sidecar.toggleChat';

  function providerLabel(baseUrl: string): string {
    if (isLocalOllama(baseUrl)) return 'Ollama';
    if (baseUrl.includes('anthropic')) return 'Anthropic';
    if (baseUrl.includes('openai')) return 'OpenAI';
    if (isKickstand(baseUrl)) return 'Kickstand';
    return 'Remote';
  }

  function renderStatusBar(health: HealthSnapshot): void {
    const shortModel = cachedModel.split(':')[0];
    const provider = providerLabel(cachedBaseUrl);

    let icon: string;
    let bgColor: ThemeColor | undefined;
    let statusLine: string;
    switch (health.status) {
      case 'error':
        icon = '$(error)';
        bgColor = new ThemeColor('statusBarItem.errorBackground');
        statusLine = `**Disconnected** — ${health.detail ?? 'backend error'}`;
        break;
      case 'degraded':
        icon = '$(warning)';
        bgColor = new ThemeColor('statusBarItem.warningBackground');
        statusLine = `**Degraded** — ${health.detail ?? 'rate-limited'}`;
        break;
      case 'ok':
        icon = '$(hubot)';
        bgColor = undefined;
        statusLine = '**Ready** — last request succeeded';
        break;
      default:
        icon = '$(hubot)';
        bgColor = undefined;
        statusLine = 'Ready — no requests yet this session';
    }

    statusBar.text = `${icon} ${shortModel}`;
    statusBar.backgroundColor = bgColor;

    // Rich MarkdownString tooltip with current state + clickable command
    // links so the user can jump straight to recovery actions without
    // leaving the hover.
    const md = new MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = false;
    md.appendMarkdown(`### SideCar\n\n`);
    md.appendMarkdown(`${statusLine}\n\n`);
    md.appendMarkdown(`**Model:** \`${cachedModel}\`  \n`);
    md.appendMarkdown(`**Backend:** ${provider}\n\n`);
    if (health.lastError && health.status === 'error') {
      md.appendMarkdown(`---\n\n**Last error:**\n\n\`\`\`\n${health.lastError}\n\`\`\`\n\n`);
    }
    md.appendMarkdown(`[Toggle chat](command:sidecar.toggleChat) · `);
    md.appendMarkdown(`[Switch backend](command:sidecar.switchBackend) · `);
    md.appendMarkdown(`[Set API key](command:sidecar.setApiKey)`);
    statusBar.tooltip = md;
  }

  renderStatusBar(healthStatus.get());
  statusBar.show();
  context.subscriptions.push(statusBar);
  context.subscriptions.push(healthStatus.onDidChange((snap) => renderStatusBar(snap)));

  // Spend status bar — tracks estimated session cost for remote API models
  const spendBar = window.createStatusBarItem(StatusBarAlignment.Right, 99);
  spendBar.command = 'sidecar.showSpend';
  spendBar.text = `$(credit-card) ${formatUsd(0)}`;
  spendBar.tooltip = 'SideCar — estimated session spend (click for breakdown)';
  spendBar.hide();
  context.subscriptions.push(spendBar);
  context.subscriptions.push(
    spendTracker.onDidChange((snap) => {
      if (snap.byModel.length === 0) {
        spendBar.hide();
        return;
      }
      spendBar.text = `$(credit-card) ${formatUsd(snap.totalUsd)}`;
      spendBar.tooltip = `SideCar — ${formatUsd(snap.totalUsd)} estimated across ${snap.totalRequests} request(s). Click for breakdown.`;
      spendBar.show();
    }),
  );
  context.subscriptions.push(
    commands.registerCommand('sidecar.showSpend', async () => {
      const snap = spendTracker.snapshot();
      // v0.62.1 p.1b: include critic session stats in the same view.
      // Users flagged "I can't tell how often the critic is blocking
      // my turns" as the biggest observability gap; surfacing this
      // alongside spend is the cheapest way to make it visible.
      const { getCriticStats, resetCriticStats } = await import('./agent/loop/criticHook.js');
      const critic = getCriticStats();
      if (snap.byModel.length === 0 && critic.totalCalls === 0) {
        window.showInformationMessage('SideCar: no remote API spend or critic activity tracked this session.');
        return;
      }
      const items = snap.byModel.map((m) => ({
        label: `${formatUsd(m.costUsd)}  ·  ${m.model}`,
        description: `${m.requests} request(s)`,
        detail: `in ${m.usage.inputTokens.toLocaleString()} · out ${m.usage.outputTokens.toLocaleString()} · cache write ${m.usage.cacheCreationInputTokens.toLocaleString()} · cache read ${m.usage.cacheReadInputTokens.toLocaleString()}`,
      }));
      const sessionMinutes = Math.max(1, Math.round((Date.now() - snap.sessionStart) / 60_000));
      items.unshift({
        label: `$(info) Total: ${formatUsd(snap.totalUsd)}`,
        description: `${snap.totalRequests} request(s) over ${sessionMinutes} min`,
        detail: 'Estimated — list prices; actual billing may differ. Click "Reset" below to clear.',
      });
      if (critic.totalCalls > 0) {
        items.push({
          label: `$(search-view-icon) Critic: ${critic.blockedTurns} blocked turn(s) / ${critic.totalCalls} call(s)`,
          description: critic.lastBlockedReason ? `Last block: ${critic.lastBlockedReason}` : '',
          detail: 'Critic-invoked LLM calls fire independently of main-loop requests.',
        });
      }
      items.push({
        label: '$(trash) Reset session spend',
        description: '',
        detail: '',
      });
      const picked = await window.showQuickPick(items, {
        title: 'SideCar — Session Spend (estimated)',
        placeHolder: 'Claude API session cost breakdown',
      });
      if (picked?.label.startsWith('$(trash)')) {
        spendTracker.reset();
        resetCriticStats();
        window.showInformationMessage('SideCar session spend + critic stats reset.');
      }
    }),
  );
  context.subscriptions.push(
    commands.registerCommand('sidecar.resetSpend', () => {
      spendTracker.reset();
      window.showInformationMessage('SideCar session spend reset.');
    }),
  );

  // Diagnostics collection — owns the Problems panel entries for
  // SideCar-detected secrets, stubs, and vulnerability patterns. The
  // executor pushes into it after write operations; the command
  // below lets the user manually clear stale entries.
  context.subscriptions.push(disposeDiagnostics());
  context.subscriptions.push(
    commands.registerCommand('sidecar.clearDiagnostics', () => {
      clearSidecarDiagnostics();
      window.showInformationMessage('SideCar diagnostics cleared from Problems panel.');
    }),
  );

  // Audit Mode review commands — the user-facing side of the
  // `sidecar.agentMode = 'audit'` buffer. Registered unconditionally
  // (not gated on agent mode) because users may toggle out of audit
  // mode while changes are still pending and still need to flush or
  // discard them.
  context.subscriptions.push(
    commands.registerCommand('sidecar.audit.review', async () => {
      const { reviewAuditBuffer, createDefaultAuditReviewUi } = await import('./agent/audit/reviewCommands.js');
      const { getRootUri } = await import('./agent/tools/shared.js');
      await reviewAuditBuffer({ rootUri: getRootUri(), ui: createDefaultAuditReviewUi() });
    }),
    commands.registerCommand('sidecar.audit.acceptAll', async () => {
      const { acceptAllAuditBuffer, createDefaultAuditReviewUi } = await import('./agent/audit/reviewCommands.js');
      const { getRootUri } = await import('./agent/tools/shared.js');
      await acceptAllAuditBuffer({ rootUri: getRootUri(), ui: createDefaultAuditReviewUi() });
    }),
    commands.registerCommand('sidecar.audit.rejectAll', async () => {
      const { rejectAllAuditBuffer, createDefaultAuditReviewUi } = await import('./agent/audit/reviewCommands.js');
      const { getRootUri } = await import('./agent/tools/shared.js');
      await rejectAllAuditBuffer({ rootUri: getRootUri(), ui: createDefaultAuditReviewUi() });
    }),
  );

  // Getting-started walkthrough — opens the native Welcome editor at
  // the SideCar page. Users can reopen it any time from the Command
  // Palette without our extension needing to own the UI surface.
  context.subscriptions.push(
    commands.registerCommand('sidecar.openWalkthrough', () => {
      commands.executeCommand(
        'workbench.action.openWalkthrough',
        `${context.extension.id}#sidecar.gettingStarted`,
        false,
      );
    }),
  );

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

  // Invalidate cached config when core settings change. Health state
  // is reset too — switching backend or key means we no longer know
  // whether the new target is healthy until the next request lands.
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('sidecar.model') ||
        e.affectsConfiguration('sidecar.baseUrl') ||
        e.affectsConfiguration('sidecar.apiKey')
      ) {
        const newConfig = getConfig();
        cachedModel = newConfig.model;
        cachedBaseUrl = newConfig.baseUrl;
        healthStatus.reset();
        renderStatusBar(healthStatus.get());
      }
    }),
  );

  console.log('SideCar extension activated');
}

/**
 * v0.61 a.3 — wire persistence to the Audit Buffer singleton + prompt
 * the user to recover any prior-session state. Kept out of the
 * activation hot path as a separate async helper because loading
 * `workspace.fs.readFile` on `.sidecar/audit-buffer/state.json` is
 * the kind of thing we want to fire-and-forget after trust + sidecar
 * dir setup finishes.
 *
 * On recovery: prompts the user with Accept All Pending (flush now)
 * / Keep for Review / Discard. If they pick Discard, the persisted
 * state gets cleared. Defaults to Keep for Review on ESC.
 */
async function initAuditBufferRecovery(): Promise<void> {
  const { getDefaultAuditBuffer } = await import('./agent/audit/auditBuffer.js');
  const { createWorkspaceAuditBufferPersistence } = await import('./agent/audit/auditBufferPersistence.js');
  const persistence = createWorkspaceAuditBufferPersistence();
  const buf = getDefaultAuditBuffer();
  buf.setPersistence(persistence);

  let recovered: Awaited<ReturnType<typeof persistence.load>>;
  try {
    recovered = await persistence.load();
  } catch (err) {
    console.warn('[SideCar] Audit buffer load failed:', err);
    return;
  }
  if (!recovered || (recovered.entries.length === 0 && recovered.commits.length === 0)) return;

  const nChanges = recovered.entries.length;
  const nCommits = recovered.commits.length;
  const commitSuffix = nCommits > 0 ? ` + ${nCommits} commit${nCommits === 1 ? '' : 's'}` : '';
  const choice = await window.showInformationMessage(
    `SideCar audit: ${nChanges} buffered change${nChanges === 1 ? '' : 's'}${commitSuffix} from your previous session. What would you like to do?`,
    { modal: false },
    'Review',
    'Discard',
  );
  if (choice === 'Discard') {
    await persistence.clear();
    return;
  }
  // Default / Review: restore to in-memory buffer. The user can open
  // `SideCar: Audit: Review Buffered Changes` at their leisure.
  buf.restore(recovered);
}

export function deactivate() {
  chatProvider?.autoSave();
  chatProvider?.abort();
  disposeSidecarMdWatcher();
  disposeShellSession();
}
