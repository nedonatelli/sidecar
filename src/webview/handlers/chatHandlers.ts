import { window, workspace, Uri, RelativePattern } from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import type { ChatState } from '../chatState.js';
import type { ContentBlock } from '../../ollama/types.js';
import { getContentLength, getContentText } from '../../ollama/types.js';
import { getConfig } from '../../config/settings.js';
import { GitCLI } from '../../github/git.js';
import {
  getWorkspaceContext,
  getWorkspaceEnabled,
  getWorkspaceRoot,
  getFilePatterns,
  getMaxFiles,
  resolveFileReferences,
  resolveAtReferences,
  extractPinReferences,
  resolveUrlReferences,
} from '../../config/workspace.js';
import { runAgentLoop } from '../../agent/loop.js';
import { pruneHistory, enhanceContextWithSmartElements } from '../../agent/context.js';
import { computeUnifiedDiff } from '../../agent/diff.js';
import { commands } from 'vscode';

const execAsync = promisify(exec);

let sidecarMdCache: string | null | undefined;
let sidecarMdWatcher: { dispose(): void } | null = null;

/** Dispose file watchers created by loadSidecarMd. Call on extension deactivate. */
export function disposeSidecarMdWatcher(): void {
  sidecarMdWatcher?.dispose();
  sidecarMdWatcher = null;
  sidecarMdCache = undefined;
}

async function loadSidecarMd(): Promise<string | null> {
  if (sidecarMdCache !== undefined) return sidecarMdCache;

  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return null;

  // Check .sidecar/SIDECAR.md first, fall back to root SIDECAR.md
  const candidates = [Uri.joinPath(rootUri, '.sidecar', 'SIDECAR.md'), Uri.joinPath(rootUri, 'SIDECAR.md')];

  sidecarMdCache = null;
  for (const fileUri of candidates) {
    try {
      const bytes = await workspace.fs.readFile(fileUri);
      const content = Buffer.from(bytes).toString('utf-8').trim();
      if (content) {
        sidecarMdCache = content;
        break;
      }
    } catch {
      // Not found — try next
    }
  }

  // Watch for changes at both locations and invalidate cache
  if (!sidecarMdWatcher) {
    const invalidate = () => {
      sidecarMdCache = undefined;
    };
    const watcher1 = workspace.createFileSystemWatcher(new RelativePattern(rootUri, 'SIDECAR.md'));
    const watcher2 = workspace.createFileSystemWatcher(new RelativePattern(rootUri, '.sidecar/SIDECAR.md'));
    for (const w of [watcher1, watcher2]) {
      w.onDidChange(invalidate);
      w.onDidCreate(invalidate);
      w.onDidDelete(invalidate);
    }
    sidecarMdWatcher = {
      dispose: () => {
        watcher1.dispose();
        watcher2.dispose();
      },
    };
  }

  return sidecarMdCache;
}

function getActiveFileContext(): string {
  const editor = window.activeTextEditor;
  if (!editor) return '';
  const doc = editor.document;
  const root = getWorkspaceRoot();
  const fileName = root ? path.relative(root, doc.fileName) : doc.fileName;
  const cursorLine = editor.selection.active.line + 1;
  const content = doc.getText();
  const maxChars = 50_000;
  const truncated = content.length > maxChars ? content.slice(0, maxChars) + '\n... (truncated)' : content;
  return `[Active file: ${fileName}, cursor at line ${cursorLine}]\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
}

export function classifyError(message: string): {
  errorType: 'connection' | 'auth' | 'model' | 'timeout' | 'unknown';
  errorAction?: string;
  errorActionCommand?: string;
} {
  const lower = message.toLowerCase();
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eaddrnotavail') ||
    lower.includes('ehostunreach') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return { errorType: 'connection', errorAction: 'Check Connection', errorActionCommand: 'openSettings' };
  }
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key')
  ) {
    return { errorType: 'auth', errorAction: 'Check API Key', errorActionCommand: 'openSettings' };
  }
  if (lower.includes('404') && (lower.includes('model') || lower.includes('not found'))) {
    return { errorType: 'model', errorAction: 'Install Model' };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return { errorType: 'timeout', errorAction: 'Retry' };
  }
  return { errorType: 'unknown' };
}

export async function handleUserMessage(state: ChatState, text: string): Promise<void> {
  // Abort any previous agent run BEFORE mutating messages.
  // This prevents race conditions where the old agent loop reads
  // messages while we're pushing a new one.
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }

  if (text) {
    state.messages.push({ role: 'user', content: text });
    state.saveHistory();
  }

  state.postMessage({ command: 'setLoading', isLoading: true });

  state.abortController = new AbortController();

  // Decay workspace index relevance so old accesses fade
  state.workspaceIndex?.decayRelevance();

  try {
    const config = getConfig();
    state.postMessage({ command: 'typingStatus', content: 'Connecting to model...' });
    let started = await ensureProviderRunning(state);

    // Auto-retry with backoff if initial connection fails
    if (!started) {
      const retryDelays = [2000, 4000, 8000];
      for (let attempt = 0; attempt < retryDelays.length; attempt++) {
        state.postMessage({
          command: 'typingStatus',
          content: `Connection failed — retrying (${attempt + 1}/${retryDelays.length})...`,
        });
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        if (state.abortController?.signal.aborted) return;
        started = await isReachable(state);
        if (started) break;
      }
    }

    if (!started) {
      state.postMessage(
        state.client.isLocalOllama()
          ? {
              command: 'error',
              content: 'Ollama is not running and could not be started after 3 retries.',
              errorType: 'connection',
              errorAction: 'Reconnect',
              errorActionCommand: 'reconnect',
            }
          : {
              command: 'error',
              content: `Cannot reach API at ${config.baseUrl} after 3 retries.`,
              errorType: 'connection',
              errorAction: 'Reconnect',
              errorActionCommand: 'reconnect',
            },
      );
      return;
    }

    const model = config.model;
    state.client.updateConnection(config.baseUrl, config.apiKey);
    state.client.updateModel(model);

    // Build system prompt with workspace context.
    // Use a compact prompt for local models (smaller context windows) and
    // a more detailed one for cloud APIs with larger context budgets.
    const isLocal = state.client.isLocalOllama();
    const pkg = state.context.extension?.packageJSON || {};
    const extensionVersion = pkg.version || 'unknown';
    const repoUrl = pkg.repository?.url || 'https://github.com/nedonatelli/sidecar';
    const docsUrl = 'https://nedonatelli.github.io/sidecar/';
    const root = getWorkspaceRoot();
    let systemPrompt = isLocal
      ? [
          `You are SideCar v${extensionVersion}, an AI coding assistant in VS Code.`,
          `Project: ${root}`,
          '',
          'RULES:',
          '1. Questions → answer with text. Actions (create, edit, fix, run, test) → use tools.',
          '2. Keep answers short and direct. One paragraph for simple questions. No lists unless asked.',
          '3. NEVER repeat information you already said in this conversation.',
          '4. Use relative paths from the project root.',
          '5. After editing files, call get_diagnostics to check for errors.',
          '6. After fixing bugs, call run_tests to verify.',
          '7. Read files before editing them. Use grep or search_files to find code.',
          '8. If you already answered the question before using a tool, just add new information from the tool result — do not restate your previous answer.',
        ].join('\n')
      : [
          `You are SideCar v${extensionVersion}, an AI coding assistant running inside VS Code. GitHub: ${repoUrl} | Docs: ${docsUrl}`,
          `Project root: ${root}`,
          '',
          'You have tools to read, write, edit, and search files, run shell commands, check diagnostics, and run tests.',
          '',
          'RULES:',
          '1. If the user asks a question or wants a conversation, respond with text — do NOT call tools.',
          '2. If the user asks you to take an action (create, edit, fix, run, test), use the appropriate tools.',
          '3. Keep responses concise. Give direct answers, not exhaustive lists. Avoid repeating yourself.',
          '4. Use relative paths from the project root.',
          '5. After editing files, call get_diagnostics to check for errors.',
          '6. After fixing bugs or adding features, call run_tests to verify your changes pass.',
          '7. Read files before editing them. Use grep or search_files to locate code first.',
          '8. For multi-step tasks, plan your approach, then execute step by step.',
          '9. If you already answered before using a tool, only add new information — do not restate what you said.',
        ].join('\n');

    // Append SIDECAR.md and user prompt with size limits to prevent context overflow.
    // Reserve at least 50% of context for conversation and tool results.
    // Cap local model context at 16K tokens — many models advertise huge context
    // windows (e.g. 262K) but Ollama's default num_ctx is much smaller, and large
    // prompts cause extreme first-token latency on local hardware.
    state.postMessage({ command: 'typingStatus', content: 'Building context...' });
    const rawContextLength = await state.client.getModelContextLength();
    const LOCAL_CONTEXT_CAP = 8_192;
    const contextLength =
      isLocal && rawContextLength && rawContextLength > LOCAL_CONTEXT_CAP ? LOCAL_CONTEXT_CAP : rawContextLength;
    const maxSystemChars = contextLength ? Math.floor(contextLength * 4 * 0.5) : 80_000;

    const sidecarMd = await loadSidecarMd();
    if (sidecarMd) {
      const truncated =
        sidecarMd.length > maxSystemChars - systemPrompt.length
          ? sidecarMd.slice(0, maxSystemChars - systemPrompt.length - 100) + '\n... (SIDECAR.md truncated)'
          : sidecarMd;
      systemPrompt += `\n\nProject instructions (from SIDECAR.md):\n${truncated}`;
    }

    const userSystemPrompt = config.systemPrompt;
    if (userSystemPrompt && systemPrompt.length < maxSystemChars) {
      const remaining = maxSystemChars - systemPrompt.length;
      const truncated =
        userSystemPrompt.length > remaining
          ? userSystemPrompt.slice(0, remaining - 50) + '\n... (system prompt truncated)'
          : userSystemPrompt;
      systemPrompt += `\n\n${truncated}`;
    }

    // Skill injection: match user message against loaded skills and inject
    // the skill prompt into the system context for this request.
    if (state.skillLoader?.isReady() && text) {
      const skill = state.skillLoader.match(text);
      if (skill && systemPrompt.length + skill.content.length < maxSystemChars) {
        systemPrompt += `\n\n## Active Skill: ${skill.name}\n${skill.content}`;
      }
    }

    if (getWorkspaceEnabled()) {
      // Enforce a tight budget on workspace context.  For local models, tool
      // definitions add ~8-10K chars to the request on top of the system
      // prompt, so we reserve headroom for those.  Without this, the prompt
      // can grow so large that the model returns empty responses.
      const toolOverheadChars = isLocal ? 10_000 : 0;
      const contextBudget = Math.max(0, maxSystemChars - systemPrompt.length - toolOverheadChars);

      if (state.workspaceIndex?.isReady()) {
        // Apply pinned context from settings + @pin: references
        state.workspaceIndex.setPinnedPaths(config.pinnedContext);
        const pinRefs = extractPinReferences(text);
        for (const pin of pinRefs) {
          state.workspaceIndex.addPin(pin);
        }

        // Use indexed context with relevance scoring
        const activeFilePath = window.activeTextEditor
          ? path.relative(getWorkspaceRoot(), window.activeTextEditor.document.uri.fsPath)
          : undefined;
        const indexContext = await state.workspaceIndex.getRelevantContext(text, activeFilePath);
        if (indexContext) {
          const trimmed =
            indexContext.length > contextBudget
              ? indexContext.slice(0, contextBudget - 30) + '\n... (context truncated)'
              : indexContext;
          systemPrompt += `\n\n${trimmed}`;
        }
        // Boost relevance for files mentioned in this message
        const mentionedPaths = [...text.matchAll(/@file:([^\s]+)/g)].map((m) => m[1]);
        if (mentionedPaths.length > 0) {
          state.workspaceIndex.updateRelevance(mentionedPaths);
        }
      } else {
        // Fallback to glob-based context while index is building
        let context = await getWorkspaceContext(getFilePatterns(), getMaxFiles());
        if (context) {
          // Apply smart element extraction so the fallback path also benefits
          context = enhanceContextWithSmartElements(context, text);
          const trimmed =
            context.length > contextBudget
              ? context.slice(0, contextBudget - 30) + '\n... (context truncated)'
              : context;
          systemPrompt += `\n\n${trimmed}`;
        }
      }
    }

    state.client.updateSystemPrompt(systemPrompt);

    // Build API messages with enriched context
    const chatMessages = [...state.messages];
    if (chatMessages.length > 0) {
      let lastUserIdx = -1;
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx !== -1) {
        let enriched =
          typeof chatMessages[lastUserIdx].content === 'string' ? (chatMessages[lastUserIdx].content as string) : '';

        if (config.includeActiveFile) {
          const activeCtx = getActiveFileContext();
          if (activeCtx) {
            enriched = activeCtx + enriched;
          }
        }

        enriched = await resolveFileReferences(enriched);
        enriched = await resolveAtReferences(enriched);
        if (config.fetchUrlContext) {
          enriched = await resolveUrlReferences(enriched);
        }

        chatMessages[lastUserIdx] = { ...chatMessages[lastUserIdx], content: enriched };
      }
    }

    // Prune old conversation history to keep context manageable.
    // Reserve ~50% of context for system prompt + model output; use the rest for history.
    const systemChars = systemPrompt.length;
    const historyBudget = contextLength ? Math.floor(contextLength * 4 * 0.5) - systemChars : 200_000 - systemChars;
    const prunedMessages = pruneHistory(chatMessages, Math.max(historyBudget, 20_000));
    if (prunedMessages.length < chatMessages.length) {
      const before = chatMessages.reduce((s, m) => s + getContentLength(m.content), 0);
      const after = prunedMessages.reduce((s, m) => s + getContentLength(m.content), 0);
      if (config.verboseMode) {
        state.postMessage({
          command: 'verboseLog',
          content: `Pruned conversation: ${chatMessages.length} → ${prunedMessages.length} messages, ~${Math.round((before - after) / 4)} tokens freed`,
          verboseLabel: 'Context Pruning',
        });
      }
    }
    // Replace chatMessages with pruned version
    // Replace chatMessages with pruned version.
    // Note: pruneHistory may return the same array reference when it
    // short-circuits, so we must copy before clearing.
    const pruned = [...prunedMessages];
    chatMessages.length = 0;
    chatMessages.push(...pruned);

    // Warn if context may still exceed the model's limit
    if (contextLength) {
      const totalChars = chatMessages.reduce((sum, m) => sum + getContentLength(m.content), 0);
      const estimatedTokens = Math.ceil(totalChars / 4);
      if (estimatedTokens > contextLength * 0.8) {
        state.postMessage({
          command: 'assistantMessage',
          content: `⚠️ Warning: Your conversation (~${estimatedTokens} tokens) may exceed this model's ${contextLength} token context window. Consider switching to a model with a larger context, reducing maxFiles, or starting a new conversation.\n\n`,
        });
      }
    }

    // Verbose mode helper
    const verbose = config.verboseMode;
    const verboseLog = (label: string, content: string) => {
      if (verbose) {
        state.postMessage({ command: 'verboseLog', content, verboseLabel: label });
      }
    };

    // Feature 5: System prompt inspector — send assembled prompt in verbose mode
    if (verbose) {
      verboseLog('System Prompt', systemPrompt);
    }

    // Send expandThinking preference to webview
    state.postMessage({ command: 'typingStatus', content: 'Sending to model...' });
    state.postMessage({ command: 'setLoading', isLoading: true, expandThinking: config.expandThinking });

    // Run agent loop with tool use
    state.metricsCollector.startRun();
    const updatedMessages = await runAgentLoop(
      state.client,
      chatMessages,
      {
        onText: (t) => {
          state.postMessage({ command: 'assistantMessage', content: t });
        },
        onThinking: (thinking) => {
          state.postMessage({ command: 'thinking', content: thinking });
        },
        onToolCall: (name, input, id) => {
          const summary = Object.entries(input)
            .map(([k, v]) => {
              const val = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '...' : String(v);
              return `${k}: ${val}`;
            })
            .join(', ');
          state.postMessage({ command: 'toolCall', toolName: name, toolCallId: id, content: `${name}(${summary})` });
          state.metricsCollector.recordToolStart();
          // Verbose: explain tool selection
          if (verbose) {
            verboseLog('Tool Selected', `Invoking ${name} with: ${summary}`);
          }
          // Track file access for workspace index relevance
          if (state.workspaceIndex && typeof input.path === 'string') {
            const accessType = name === 'read_file' ? 'read' : 'write';
            if (['read_file', 'write_file', 'edit_file'].includes(name)) {
              state.workspaceIndex.trackFileAccess(input.path as string, accessType);
            }
          }
        },
        onToolResult: (name, result, isError, id) => {
          const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
          state.postMessage({ command: 'toolResult', toolName: name, toolCallId: id, content: preview });
          state.metricsCollector.recordToolEnd(name, isError);
        },
        onToolOutput: (name, chunk, id) => {
          state.postMessage({ command: 'toolOutput', content: chunk, toolName: name, toolCallId: id });
        },
        onIterationStart: (info) => {
          state.postMessage({
            command: 'agentProgress',
            iteration: info.iteration,
            maxIterations: info.maxIterations,
            elapsedMs: info.elapsedMs,
            estimatedTokens: info.estimatedTokens,
            messageCount: info.messageCount,
            messagesRemaining: info.messagesRemaining,
            atCapacity: info.atCapacity,
          });
          // Feature 4: Per-iteration narrative
          if (verbose) {
            const elapsed = (info.elapsedMs / 1000).toFixed(1);
            const capacityWarning = info.atCapacity ? ' ⚠️ At message limit!' : '';
            verboseLog(
              `Iteration ${info.iteration}/${info.maxIterations}`,
              `Starting iteration ${info.iteration}. Elapsed: ${elapsed}s, ~${info.estimatedTokens} tokens used, ${info.messageCount} messages${capacityWarning}`,
            );
          }
        },
        onPlanGenerated: (plan) => {
          state.pendingPlan = plan;
          state.pendingPlanMessages = [...chatMessages];
          state.postMessage({ command: 'planReady', content: plan });
        },
        onDone: () => {
          state.postMessage({ command: 'done' });
        },
      },
      state.abortController.signal,
      {
        logger: state.agentLogger,
        changelog: state.changelog,
        mcpManager: state.mcpManager,
        approvalMode: config.agentMode,
        planMode: config.planMode,
        maxIterations: config.agentMaxIterations,
        maxTokens: config.agentMaxTokens,
        confirmFn: (msg, actions) => state.requestConfirm(msg, actions),
        diffPreviewFn: state.contentProvider
          ? async (filePath: string, proposedContent: string) => {
              const cp = state.contentProvider!;
              const key = `/${filePath}`;
              const proposedUri = cp.addProposal(key, proposedContent);
              const rootUri = workspace.workspaceFolders?.[0]?.uri;
              if (!rootUri) {
                cp.removeProposal(key);
                return 'reject' as const;
              }
              const originalUri = Uri.joinPath(rootUri, filePath);
              await commands.executeCommand('vscode.diff', originalUri, proposedUri, `SideCar: ${filePath} (proposed)`);
              const choice = await state.requestConfirm(`Apply changes to **${filePath}**?`, ['Accept', 'Reject']);
              cp.removeProposal(key);
              return choice === 'Accept' ? ('accept' as const) : ('reject' as const);
            }
          : undefined,
      },
    );

    // Merge agent output with any messages added during the run (e.g., user sent
    // a new message while the agent was working). The agent loop started with a
    // snapshot of chatMessages — append any new messages the user added since then.
    const newUserMessages = state.messages.slice(chatMessages.length);
    state.messages = [...updatedMessages, ...newUserMessages];
    state.trimHistory();
    state.saveHistory();
    state.autoSave();

    // Send change summary if any files were modified
    if (state.changelog.hasChanges()) {
      const changes = await state.changelog.getChangeSummary();
      const summaryItems = changes
        .map((c) => ({
          filePath: c.filePath,
          diff: computeUnifiedDiff(c.filePath, c.original, c.current),
          isNew: c.original === null,
          isDeleted: c.current === null,
        }))
        .filter((item) => item.diff.length > 0);
      if (summaryItems.length > 0) {
        state.postMessage({ command: 'changeSummary', changeSummary: summaryItems });
      }
    }

    // Ensure loading state is cleared after normal completion
    state.postMessage({ command: 'setLoading', isLoading: false });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      state.autoSave();
      state.postMessage({ command: 'done' });
      state.postMessage({ command: 'setLoading', isLoading: false });
      return;
    }
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const classified = classifyError(errorMessage);
    state.postMessage({ command: 'error', content: `Error: ${errorMessage}`, ...classified });
  } finally {
    state.metricsCollector.endRun();
    state.abortController = null;
    // Always ensure loading indicator is cleared, regardless of how we got here
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
}

export function handleUserMessageWithImages(
  state: ChatState,
  text: string,
  images: { mediaType: string; data: string }[],
): void {
  const content: ContentBlock[] = images.map((img) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mediaType as 'image/png', data: img.data },
  }));
  content.push({ type: 'text', text: text || '' });
  state.messages.push({ role: 'user', content });
  state.saveHistory();
}

// --- Provider management ---

async function isReachable(state: ChatState): Promise<boolean> {
  const config = getConfig();
  const provider = state.client.getProviderType();
  try {
    let checkUrl: string;
    const headers: Record<string, string> = {};

    switch (provider) {
      case 'ollama':
        checkUrl = `${config.baseUrl}/api/tags`;
        break;
      case 'anthropic':
        checkUrl = config.baseUrl;
        headers['x-api-key'] = config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
      case 'openai':
        checkUrl = `${config.baseUrl}/v1/models`;
        if (config.apiKey && config.apiKey !== 'ollama') {
          headers['Authorization'] = `Bearer ${config.apiKey}`;
        }
        break;
      default:
        checkUrl = config.baseUrl;
        break;
    }

    const response = await fetch(checkUrl, { headers });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureProviderRunning(state: ChatState): Promise<boolean> {
  if (await isReachable(state)) return true;

  if (!state.client.isLocalOllama()) return false;

  try {
    const { spawn } = await import('child_process');
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    return false;
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isReachable(state)) return true;
  }

  return false;
}

/**
 * Manual reconnect: try to reach the provider, start Ollama if local,
 * and resend the last user message on success.
 */
export async function handleReconnect(state: ChatState): Promise<void> {
  state.postMessage({ command: 'setLoading', isLoading: true });
  state.postMessage({ command: 'typingStatus', content: 'Reconnecting...' });

  const started = await ensureProviderRunning(state);
  if (started) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'Reconnected to model successfully.\n',
    });
    state.postMessage({ command: 'done' });

    // Resend the last user message automatically
    const lastUserMsg = [...state.messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      const text =
        typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : lastUserMsg.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      // Remove the last user message so handleUserMessage re-adds it
      state.messages.pop();
      await handleUserMessage(state, text);
    }
  } else {
    state.postMessage({
      command: 'error',
      content: 'Still unable to connect. Check that Ollama is running and try again.',
      errorType: 'connection',
      errorAction: 'Reconnect',
      errorActionCommand: 'reconnect',
    });
  }
}

// --- File handlers ---

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']);

export async function handleAttachFile(state: ChatState): Promise<void> {
  const editor = window.activeTextEditor;

  const options: string[] = [];
  if (editor) {
    options.push('Active File: ' + path.basename(editor.document.fileName));
  }
  options.push('Browse...');

  const pick =
    options.length === 1 ? options[0] : await window.showQuickPick(options, { placeHolder: 'Select a file to attach' });
  if (!pick) return;

  if (pick.startsWith('Active File') && editor) {
    const fileName = path.basename(editor.document.fileName);
    const ext = path.extname(fileName).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      await attachImage(state, Uri.file(editor.document.fileName));
    } else {
      const fileContent = editor.document.getText();
      if (fileContent.length > 500_000) {
        window.showWarningMessage(`File "${fileName}" is too large to attach (>500KB).`);
        return;
      }
      state.postMessage({ command: 'fileAttached', fileName, fileContent });
    }
  } else {
    const uris = await window.showOpenDialog({ canSelectMany: false });
    if (!uris || uris.length === 0) return;
    const fileName = path.basename(uris[0].fsPath);
    const ext = path.extname(fileName).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      await attachImage(state, uris[0]);
    } else {
      const doc = await workspace.openTextDocument(uris[0]);
      const fileContent = doc.getText();
      if (fileContent.length > 500_000) {
        window.showWarningMessage(`File "${fileName}" is too large to attach (>500KB).`);
        return;
      }
      state.postMessage({ command: 'fileAttached', fileName, fileContent });
    }
  }
}

async function attachImage(state: ChatState, uri: Uri): Promise<void> {
  const bytes = await workspace.fs.readFile(uri);
  const ext = path.extname(uri.fsPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  const mediaType = mimeMap[ext] || 'image/png';
  const data = Buffer.from(bytes).toString('base64');
  state.postMessage({ command: 'imageAttached', mediaType, data });
}

export async function handleSaveCodeBlock(code: string, language?: string): Promise<void> {
  const ext = language ? languageToExtension(language) : '.txt';
  const uri = await window.showSaveDialog({
    filters: { 'All Files': ['*'] },
    defaultUri: Uri.file('untitled' + ext),
  });
  if (!uri) return;

  await workspace.fs.writeFile(uri, Buffer.from(code, 'utf-8'));
  window.showInformationMessage(`Saved to ${path.basename(uri.fsPath)}`);
}

export async function handleCreateFile(state: ChatState, code: string, filePath: string): Promise<void> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    state.postMessage({ command: 'error', content: 'No workspace folder open.' });
    return;
  }

  const rootUri = workspaceFolders[0].uri;
  const fileUri = Uri.joinPath(rootUri, filePath);

  let exists = false;
  try {
    await workspace.fs.stat(fileUri);
    exists = true;
  } catch {
    // File doesn't exist
  }

  if (exists) {
    const choice = await state.requestConfirm(`"${filePath}" already exists. Overwrite?`, ['Overwrite', 'Cancel']);
    if (choice !== 'Overwrite') return;
  }

  try {
    await workspace.fs.createDirectory(Uri.joinPath(rootUri, path.dirname(filePath)));
    await workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf-8'));
    window.showInformationMessage(`Created ${filePath}`);
  } catch (err) {
    state.postMessage({
      command: 'error',
      content: `Failed to create file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function handleRunCommand(state: ChatState, command: string): Promise<string | null> {
  const choice = await state.requestConfirm(`SideCar wants to run: \`${command}\``, ['Allow', 'Deny']);
  if (choice !== 'Allow') {
    state.postMessage({ command: 'commandResult', content: 'Command cancelled by user.' });
    return null;
  }

  const terminalOutput = await state.terminalManager.executeCommand(command);
  if (terminalOutput !== null) {
    return terminalOutput;
  }

  const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout || stderr || '(no output)';
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return error.stderr || error.stdout || error.message || 'Command failed';
  }
}

export async function handleMoveFile(state: ChatState, sourcePath: string, destPath: string): Promise<void> {
  if (!sourcePath || !destPath) {
    state.postMessage({ command: 'error', content: 'Move requires both a source and destination path.' });
    return;
  }

  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    state.postMessage({ command: 'error', content: 'No workspace folder open.' });
    return;
  }

  const rootUri = workspaceFolders[0].uri;
  const sourceUri = path.isAbsolute(sourcePath) ? Uri.file(sourcePath) : Uri.joinPath(rootUri, sourcePath);
  const destUri = path.isAbsolute(destPath) ? Uri.file(destPath) : Uri.joinPath(rootUri, destPath);

  try {
    await workspace.fs.stat(sourceUri);
  } catch {
    state.postMessage({ command: 'error', content: `Source not found: ${sourcePath}` });
    return;
  }

  let destExists = false;
  try {
    await workspace.fs.stat(destUri);
    destExists = true;
  } catch {
    // safe
  }

  if (destExists) {
    const choice = await state.requestConfirm(`"${destPath}" already exists. Overwrite?`, ['Overwrite', 'Cancel']);
    if (choice !== 'Overwrite') {
      state.postMessage({ command: 'fileMoved', content: 'Move cancelled.' });
      return;
    }
  }

  try {
    await workspace.fs.rename(sourceUri, destUri, { overwrite: destExists });
    state.postMessage({ command: 'fileMoved', content: `Moved "${sourcePath}" to "${destPath}"` });
  } catch (err) {
    state.postMessage({
      command: 'error',
      content: `Failed to move file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function handleUndoChanges(state: ChatState): Promise<void> {
  if (!state.changelog.hasChanges()) {
    window.showInformationMessage('No changes to undo.');
    return;
  }
  const changes = state.changelog.getChanges();
  const choice = await state.requestConfirm(`Undo ${changes.length} file change(s) made by SideCar?`, [
    'Undo All',
    'Cancel',
  ]);
  if (choice !== 'Undo All') return;
  const result = await state.changelog.rollbackAll();
  const parts: string[] = [];
  if (result.restored > 0) parts.push(`${result.restored} restored`);
  if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  window.showInformationMessage(`Undo complete: ${parts.join(', ')}`);
  state.postMessage({
    command: 'assistantMessage',
    content: `\n\n↩ Undid ${changes.length} file change(s): ${parts.join(', ')}`,
  });
}

export async function handleRevertFile(state: ChatState, filePath: string): Promise<void> {
  const success = await state.changelog.rollbackFile(filePath);
  if (success) {
    state.postMessage({
      command: 'assistantMessage',
      content: `\n\n↩ Reverted **${filePath}**`,
    });
  } else {
    state.postMessage({
      command: 'error',
      content: `Failed to revert ${filePath}`,
    });
  }

  // Send updated change summary
  if (state.changelog.hasChanges()) {
    const changes = await state.changelog.getChangeSummary();
    const summaryItems = changes
      .map((c) => ({
        filePath: c.filePath,
        diff: computeUnifiedDiff(c.filePath, c.original, c.current),
        isNew: c.original === null,
        isDeleted: c.current === null,
      }))
      .filter((item) => item.diff.length > 0);
    state.postMessage({ command: 'changeSummary', changeSummary: summaryItems });
  } else {
    state.postMessage({ command: 'changeSummary', changeSummary: [] });
  }
}

export function handleAcceptAllChanges(state: ChatState): void {
  state.changelog.clear();
  state.postMessage({
    command: 'assistantMessage',
    content: '\n\n✓ All changes accepted',
  });
}

export async function handleShowSystemPrompt(state: ChatState): Promise<void> {
  const config = getConfig();

  const pkg = state.context.extension?.packageJSON || {};
  const extensionVersion = pkg.version || 'unknown';
  const repoUrl = pkg.repository?.url || 'https://github.com/nedonatelli/sidecar';
  const docsUrl = 'https://nedonatelli.github.io/sidecar/';
  let systemPrompt = `You are SideCar v${extensionVersion}, an AI coding assistant running inside VS Code. GitHub: ${repoUrl} | Docs: ${docsUrl}\nProject root: ${getWorkspaceRoot()}\n\n(Use /verbose to see the full prompt sent during agent runs)`;

  const sidecarMd = await loadSidecarMd();
  if (sidecarMd) {
    systemPrompt += `\n\nProject instructions (from SIDECAR.md):\n${sidecarMd}`;
  }

  const userSystemPrompt = config.systemPrompt;
  if (userSystemPrompt) {
    systemPrompt += `\n\n${userSystemPrompt}`;
  }

  state.postMessage({ command: 'verboseLog', content: systemPrompt, verboseLabel: 'System Prompt' });
}

export function handleDeleteMessage(state: ChatState, index: number): void {
  if (index < 0 || index >= state.messages.length) return;
  state.messages.splice(index, 1);
  state.saveHistory();
}

export async function handleExportChat(state: ChatState): Promise<void> {
  if (state.messages.length === 0) return;
  const lines: string[] = [];
  for (const msg of state.messages) {
    const label = msg.role === 'user' ? '## User' : '## Assistant';
    const text = getContentText(msg.content);
    lines.push(`${label}\n\n${text}\n`);
  }
  const content = lines.join('\n---\n\n');
  const uri = await window.showSaveDialog({
    filters: { Markdown: ['md'] },
    defaultUri: Uri.file('sidecar-chat.md'),
  });
  if (!uri) return;
  await workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
  window.showInformationMessage(`Chat exported to ${path.basename(uri.fsPath)}`);
}

export async function handleGenerateCommit(state: ChatState): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    state.postMessage({ command: 'error', content: 'No workspace folder open.' });
    return;
  }

  const git = new GitCLI(cwd);

  try {
    // Check for changes
    const status = await git.status();
    if (status === 'Working tree clean.') {
      state.postMessage({ command: 'assistantMessage', content: 'No changes to commit.' });
      state.postMessage({ command: 'done' });
      return;
    }

    // Get diff for message generation
    const { diff } = await git.diff();
    if (diff === 'No diff output.') {
      state.postMessage({ command: 'assistantMessage', content: 'No diff found. Stage files first or make changes.' });
      state.postMessage({ command: 'done' });
      return;
    }

    const maxDiff = 15_000;
    const truncated = diff.length > maxDiff ? diff.slice(0, maxDiff) + '\n... (truncated)' : diff;

    state.postMessage({ command: 'setLoading', isLoading: true });
    state.postMessage({ command: 'assistantMessage', content: 'Generating commit message...\n\n' });

    const config = getConfig();
    state.client.updateConnection(config.baseUrl, config.apiKey);
    state.client.updateModel(config.model);

    const messages: import('../../ollama/types.js').ChatMessage[] = [
      {
        role: 'user',
        content: `Generate a concise git commit message for these changes. Follow conventional commits format (type: description). First line max 72 chars. Add a blank line then bullet points for details if needed. Output ONLY the commit message, nothing else.\n\n\`\`\`diff\n${truncated}\n\`\`\``,
      },
    ];

    let message = await state.client.complete(messages, 512);
    message = message
      .replace(/^```\w*\n?/, '')
      .replace(/\n?```$/, '')
      .trim();

    // Stage all changes and commit
    await git.stage();
    const result = await git.commit(message);

    state.postMessage({ command: 'assistantMessage', content: result + '\n' });
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.postMessage({ command: 'error', content: `Commit failed: ${msg}` });
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
}

export function languageToExtension(lang: string): string {
  const map: Record<string, string> = {
    typescript: '.ts',
    javascript: '.js',
    python: '.py',
    rust: '.rs',
    go: '.go',
    java: '.java',
    cpp: '.cpp',
    c: '.c',
    html: '.html',
    css: '.css',
    json: '.json',
    yaml: '.yaml',
    markdown: '.md',
    bash: '.sh',
    sh: '.sh',
    sql: '.sql',
    tsx: '.tsx',
    jsx: '.jsx',
  };
  return map[lang.toLowerCase()] || '.txt';
}
