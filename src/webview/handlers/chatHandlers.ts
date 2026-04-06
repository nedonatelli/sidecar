import { window, workspace, Uri } from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import type { ChatState } from '../chatState.js';
import type { ContentBlock } from '../../ollama/types.js';
import { getContentLength, getContentText } from '../../ollama/types.js';
import { getConfig } from '../../config/settings.js';
import {
  getWorkspaceContext,
  getWorkspaceEnabled,
  getWorkspaceRoot,
  getFilePatterns,
  getMaxFiles,
  resolveFileReferences,
  resolveAtReferences,
} from '../../config/workspace.js';
import { runAgentLoop } from '../../agent/loop.js';

const execAsync = promisify(exec);

async function loadSidecarMd(): Promise<string | null> {
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return null;
  try {
    const fileUri = Uri.joinPath(rootUri, 'SIDECAR.md');
    const bytes = await workspace.fs.readFile(fileUri);
    const content = Buffer.from(bytes).toString('utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
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
  if (lower.includes('econnrefused') || lower.includes('fetch failed') || lower.includes('network')) {
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
    const started = await ensureProviderRunning(state);
    if (!started) {
      state.postMessage(
        state.client.isLocalOllama()
          ? {
              command: 'error',
              content: 'Ollama is not running and could not be started.',
              errorType: 'connection',
              errorAction: 'Start Ollama',
              errorActionCommand: 'runCommand',
            }
          : {
              command: 'error',
              content: `Cannot reach API at ${config.baseUrl}.`,
              errorType: 'connection',
              errorAction: 'Check Settings',
              errorActionCommand: 'openSettings',
            },
      );
      return;
    }

    const model = config.model;
    state.client.updateConnection(config.baseUrl, config.apiKey);
    state.client.updateModel(model);

    // Build system prompt with workspace context
    let systemPrompt = `You are SideCar, an AI coding assistant running inside VS Code. You have tools to read, write, edit, and search files, run shell commands, check diagnostics, and run tests.\nProject root: ${getWorkspaceRoot()}\n\nUse your tools to accomplish tasks. Always use relative paths from the project root. Keep responses concise.\n\nAfter editing files, use get_diagnostics to check for errors and fix them. When asked to fix bugs or add features, use run_tests to verify your changes pass.`;

    const sidecarMd = await loadSidecarMd();
    if (sidecarMd) {
      systemPrompt += `\n\nProject instructions (from SIDECAR.md):\n${sidecarMd}`;
    }

    const userSystemPrompt = config.systemPrompt;
    if (userSystemPrompt) {
      systemPrompt += `\n\n${userSystemPrompt}`;
    }

    if (getWorkspaceEnabled()) {
      if (state.workspaceIndex?.isReady()) {
        // Use indexed context with relevance scoring
        const activeFilePath = window.activeTextEditor
          ? path.relative(getWorkspaceRoot(), window.activeTextEditor.document.uri.fsPath)
          : undefined;
        const indexContext = await state.workspaceIndex.getRelevantContext(text, activeFilePath);
        if (indexContext) {
          systemPrompt += `\n\n${indexContext}`;
        }
        // Boost relevance for files mentioned in this message
        const mentionedPaths = [...text.matchAll(/@file:([^\s]+)/g)].map((m) => m[1]);
        if (mentionedPaths.length > 0) {
          state.workspaceIndex.updateRelevance(mentionedPaths);
        }
      } else {
        // Fallback to glob-based context while index is building
        const context = await getWorkspaceContext(getFilePatterns(), getMaxFiles());
        if (context) {
          systemPrompt += `\n\n${context}`;
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

        chatMessages[lastUserIdx] = { ...chatMessages[lastUserIdx], content: enriched };
      }
    }

    // Warn if context may exceed the model's limit
    const contextLength = await state.client.getModelContextLength();
    if (contextLength) {
      const totalChars = chatMessages.reduce((sum, m) => sum + getContentLength(m.content), 0);
      const estimatedTokens = Math.ceil(totalChars / 3.5);
      if (estimatedTokens > contextLength * 0.8) {
        state.postMessage({
          command: 'assistantMessage',
          content: `⚠️ Warning: Your conversation (~${estimatedTokens} tokens) may exceed this model's ${contextLength} token context window. Consider switching to a model with a larger context, reducing maxFiles, or starting a new conversation.\n\n`,
        });
      }
    }

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
        onToolCall: (name, input) => {
          const summary = Object.entries(input)
            .map(([k, v]) => {
              const val = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '...' : String(v);
              return `${k}: ${val}`;
            })
            .join(', ');
          state.postMessage({ command: 'toolCall', content: `${name}(${summary})` });
          state.metricsCollector.recordToolStart();
          // Track file access for workspace index relevance
          if (state.workspaceIndex && typeof input.path === 'string') {
            const accessType = name === 'read_file' ? 'read' : 'write';
            if (['read_file', 'write_file', 'edit_file'].includes(name)) {
              state.workspaceIndex.trackFileAccess(input.path as string, accessType);
            }
          }
        },
        onToolResult: (name, result, isError) => {
          const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
          state.postMessage({ command: 'toolResult', content: `${name}: ${isError ? '✗ ' : '✓ '}${preview}` });
          state.metricsCollector.recordToolEnd(name, isError);
        },
        onIterationStart: (iteration, maxIterations, elapsedMs, estimatedTokens) => {
          state.postMessage({
            command: 'agentProgress',
            iteration,
            maxIterations,
            elapsedMs,
            estimatedTokens,
          });
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
      },
    );

    state.messages = updatedMessages;
    state.saveHistory();
    state.metricsCollector.endRun();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return;
    }
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const classified = classifyError(errorMessage);
    state.postMessage({ command: 'error', content: `Error: ${errorMessage}`, ...classified });
  } finally {
    state.abortController = null;
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
  try {
    const baseUrl = config.baseUrl;
    const checkUrl = state.client.isLocalOllama() ? `${baseUrl}/api/tags` : baseUrl;
    const response = await fetch(checkUrl, {
      headers: state.client.isLocalOllama()
        ? {}
        : {
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          },
    });
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
    const choice = await window.showWarningMessage(
      `"${filePath}" already exists. Overwrite?`,
      { modal: true },
      'Overwrite',
    );
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
  const choice = await window.showWarningMessage(`SideCar wants to run: ${command}`, { modal: true }, 'Allow');
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
    const choice = await window.showWarningMessage(
      `"${destPath}" already exists. Overwrite?`,
      { modal: true },
      'Overwrite',
    );
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
  const choice = await window.showWarningMessage(
    `Undo ${changes.length} file change(s) made by SideCar?`,
    { modal: true },
    'Undo All',
  );
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
