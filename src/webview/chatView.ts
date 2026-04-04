import {
  window,
  workspace,
  env,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  ExtensionContext,
  Uri,
  CancellationToken,
} from 'vscode';
import * as path from 'path';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { SideCarClient } from '../ollama/client.js';
import { getModel, getSystemPrompt, getBaseUrl, getApiKey, getIncludeActiveFile } from '../config/settings.js';
import { getWorkspaceContext, getWorkspaceEnabled, getWorkspaceRoot, getFilePatterns, getMaxFiles, resolveFileReferences } from '../config/workspace.js';
import type { ChatMessage, ContentBlock } from '../ollama/types.js';
import { getContentLength } from '../ollama/types.js';
import { getChatWebviewHtml, type WebviewMessage, type ExtensionMessage, type LibraryModelUI } from './chatWebview.js';
import { GitCLI } from '../github/git.js';
import { GitHubAPI } from '../github/api.js';
import { getGitHubToken } from '../github/auth.js';
import { parseEditBlocks } from '../edits/parser.js';
import { applyEdit, applyEdits } from '../edits/apply.js';
import { TerminalManager } from '../terminal/manager.js';
import { ProposedContentProvider } from '../edits/proposedContentProvider.js';
import { showDiffPreview } from '../edits/diffPreview.js';

export class ChatViewProvider implements WebviewViewProvider {
  private webviewView: WebviewView | undefined;
  private client: SideCarClient;
  private terminalManager: TerminalManager;
  private contentProvider: ProposedContentProvider;
  private messages: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private installAbortController: AbortController | null = null;

  constructor(private readonly context: ExtensionContext, terminalManager: TerminalManager, contentProvider: ProposedContentProvider) {
    this.client = new SideCarClient(getModel(), getBaseUrl(), getApiKey());
    this.terminalManager = terminalManager;
    this.contentProvider = contentProvider;
  }

  resolveWebviewView(
    webviewView: WebviewView,
    _context: WebviewViewResolveContext,
    _token: CancellationToken
  ): void | Thenable<void> {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = getChatWebviewHtml(
      webviewView.webview,
      this.context.extensionUri
    );

    webviewView.webview.onDidReceiveMessage(
      async (msg: WebviewMessage) => {
        switch (msg.command) {
          case 'userMessage':
            if (msg.images && msg.images.length > 0) {
              const content: ContentBlock[] = msg.images.map(img => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: img.mediaType as 'image/png', data: img.data },
              }));
              content.push({ type: 'text', text: msg.text || '' });
              this.messages.push({ role: 'user', content });
              this.saveHistory();
              await this.handleUserMessage('');
            } else {
              await this.handleUserMessage(msg.text || '');
            }
            break;
          case 'abort':
            this.abort();
            break;
          case 'changeModel':
            this.client.updateModel(msg.model || 'llama3');
            this.postMessage({ command: 'setCurrentModel', currentModel: msg.model });
            break;
          case 'installModel':
            await this.handleInstallModel(msg.model || '');
            break;
          case 'cancelInstall':
            this.cancelInstall();
            break;
          case 'attachFile':
            await this.handleAttachFile();
            break;
          case 'saveCodeBlock':
            await this.handleSaveCodeBlock(msg.code || '', msg.language);
            break;
          case 'createFile':
            await this.handleCreateFile(msg.code || '', msg.filePath || '');
            break;
          case 'runCommand': {
            const output = await this.handleRunCommand(msg.text || '');
            if (output !== null) {
              this.postMessage({ command: 'commandResult', content: output });
            }
            break;
          }
          case 'moveFile':
            await this.handleMoveFile(msg.sourcePath || '', msg.destPath || '');
            break;
          case 'github':
            await this.handleGitHubCommand(msg);
            break;
          case 'newChat':
            this.messages = [];
            this.saveHistory();
            this.postMessage({ command: 'chatCleared' });
            break;
          case 'exportChat':
            await this.handleExportChat();
            break;
          case 'openExternal':
            if (msg.url) {
              env.openExternal(Uri.parse(msg.url));
            }
            break;
        }
      },
      undefined,
      this.context.subscriptions
    );

    // Restore chat history
    if (this.messages.length === 0) {
      this.messages = this.loadHistory();
    }
    if (this.messages.length > 0) {
      this.postMessage({ command: 'init', messages: this.messages });
    }

    this.loadModels();
  }

  private async isReachable(): Promise<boolean> {
    try {
      const baseUrl = getBaseUrl();
      // For local Ollama, check /api/tags; for remote APIs, check the base URL
      const checkUrl = this.client.isLocalOllama()
        ? `${baseUrl}/api/tags`
        : baseUrl;
      const response = await fetch(checkUrl, {
        headers: this.client.isLocalOllama() ? {} : {
          'x-api-key': getApiKey(),
          'anthropic-version': '2023-06-01',
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async ensureProviderRunning(): Promise<boolean> {
    if (await this.isReachable()) return true;

    // Only try to auto-start local Ollama
    if (!this.client.isLocalOllama()) return false;

    try {
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
      if (await this.isReachable()) return true;
    }

    return false;
  }

  private async loadModels(): Promise<void> {
    try {
      const started = await this.ensureProviderRunning();
      if (!started) {
        this.postMessage({
          command: 'error',
          content: this.client.isLocalOllama()
            ? 'Cannot start Ollama. Make sure Ollama is installed and in your PATH.'
            : `Cannot reach API at ${getBaseUrl()}. Check your baseUrl and apiKey settings.`,
        });
        return;
      }

      const libraryModels = await this.client.listLibraryModels();
      const currentModel = getModel();

      const modelsUI: LibraryModelUI[] = libraryModels.map((m) => ({
        name: m.name,
        installed: m.installed,
      }));

      this.postMessage({ command: 'setModels', models: modelsUI });
      this.postMessage({ command: 'setCurrentModel', currentModel });
    } catch (err) {
      console.error('Failed to load models:', err);
      this.postMessage({
        command: 'error',
        content: this.client.isLocalOllama()
          ? 'Cannot connect to Ollama. Make sure Ollama is running on localhost:11434.'
          : `Cannot connect to API at ${getBaseUrl()}.`,
      });
    }
  }

  private async handleInstallModel(modelName: string): Promise<void> {
    this.installAbortController = new AbortController();

    try {
      this.postMessage({
        command: 'installProgress',
        modelName,
        progress: 'Starting...',
      });

      for await (const progress of this.client.pullModel(modelName, this.installAbortController.signal)) {
        this.postMessage({
          command: 'installProgress',
          modelName,
          progress: progress.status,
        });
      }

      this.client.updateModel(modelName);
      this.postMessage({ command: 'installComplete', modelName });
      this.postMessage({ command: 'setCurrentModel', currentModel: modelName });
      await this.loadModels();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.postMessage({ command: 'installComplete', modelName });
        return;
      }
      this.postMessage({
        command: 'error',
        content: `Failed to install ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.installAbortController = null;
    }
  }

  private cancelInstall(): void {
    this.installAbortController?.abort();
  }

  private saveHistory(): void {
    // Strip any non-string content (images) for persistence
    const serializable = this.messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '[message with images]',
    }));
    this.context.workspaceState.update('sidecar.chatHistory', serializable);
  }

  private loadHistory(): ChatMessage[] {
    return this.context.workspaceState.get<ChatMessage[]>('sidecar.chatHistory', []);
  }

  private async handleExportChat(): Promise<void> {
    if (this.messages.length === 0) return;
    const lines: string[] = [];
    for (const msg of this.messages) {
      const label = msg.role === 'user' ? '## User' : '## Assistant';
      const text = typeof msg.content === 'string' ? msg.content : '[message with images]';
      lines.push(`${label}\n\n${text}\n`);
    }
    const content = lines.join('\n---\n\n');
    const uri = await window.showSaveDialog({
      filters: { 'Markdown': ['md'] },
      defaultUri: Uri.file('sidecar-chat.md'),
    });
    if (!uri) return;
    await workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
    window.showInformationMessage(`Chat exported to ${path.basename(uri.fsPath)}`);
  }

  private getActiveFileContext(): string {
    const editor = window.activeTextEditor;
    if (!editor) return '';
    const doc = editor.document;
    const root = getWorkspaceRoot();
    const fileName = root ? path.relative(root, doc.fileName) : doc.fileName;
    const cursorLine = editor.selection.active.line + 1;
    const content = doc.getText();
    const maxChars = 50_000;
    const truncated = content.length > maxChars
      ? content.slice(0, maxChars) + '\n... (truncated)'
      : content;
    return `[Active file: ${fileName}, cursor at line ${cursorLine}]\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
  }

  public async sendCodeAction(action: string, code: string, fileName: string): Promise<void> {
    const prompt = `${action} this code from ${fileName}:\n\`\`\`\n${code}\n\`\`\``;
    if (this.webviewView) {
      this.webviewView.show(true);
    }
    this.postMessage({ command: 'addUserMessage', content: prompt });
    await this.handleUserMessage(prompt);
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (text) {
      this.messages.push({ role: 'user', content: text });
      this.saveHistory();
    }
    this.postMessage({ command: 'setLoading', isLoading: true });

    this.abortController = new AbortController();

    try {
      const started = await this.ensureProviderRunning();
      if (!started) {
        this.postMessage({ command: 'error', content: this.client.isLocalOllama()
          ? 'Ollama is not running and could not be started.'
          : `Cannot reach API at ${getBaseUrl()}.` });
        return;
      }

      const model = getModel();
      const userSystemPrompt = getSystemPrompt();
      this.client.updateConnection(getBaseUrl(), getApiKey());
      this.client.updateModel(model);

      // Build system prompt with workspace context
      let systemPrompt = `You are SideCar, an AI coding assistant running inside VS Code. You CAN create, edit, and run commands directly.\nProject root: ${getWorkspaceRoot()}\n\nTo CREATE a new file, use a code fence with the filepath after a colon:\n\`\`\`py:src/hello.py\nprint("hello")\n\`\`\`\n\nTo EDIT an existing file, use the search/replace format:\n<<<SEARCH:path/to/file.ts\nexact text to find\n===\nreplacement text\n>>>REPLACE\nYou can include multiple edit blocks in one response for multi-file changes.\n\nTo RUN a shell command:\n\`\`\`sh\npip list\n\`\`\`\nThe user will be asked to approve before the command runs.\n\nAlways use relative paths from the project root. Keep responses concise.`;

      if (userSystemPrompt) {
        systemPrompt += `\n\n${userSystemPrompt}`;
      }

      if (getWorkspaceEnabled()) {
        const context = await getWorkspaceContext(getFilePatterns(), getMaxFiles());
        if (context) {
          systemPrompt += `\n\n${context}`;
        }
      }

      this.client.updateSystemPrompt(systemPrompt);

      // Build API messages with enriched context
      const chatMessages = [...this.messages];
      if (chatMessages.length > 0) {
        // Find last user message to enrich
        let lastUserIdx = -1;
        for (let i = chatMessages.length - 1; i >= 0; i--) {
          if (chatMessages[i].role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx !== -1) {
          let enriched = typeof chatMessages[lastUserIdx].content === 'string'
            ? chatMessages[lastUserIdx].content as string : '';

          // Inject active file context
          if (getIncludeActiveFile()) {
            const activeCtx = this.getActiveFileContext();
            if (activeCtx) {
              enriched = activeCtx + enriched;
            }
          }

          // Resolve file references
          enriched = await resolveFileReferences(enriched);

          chatMessages[lastUserIdx] = { ...chatMessages[lastUserIdx], content: enriched };
        }
      }

      // Warn if context may exceed the model's limit
      const contextLength = await this.client.getModelContextLength();
      if (contextLength) {
        const totalChars = chatMessages.reduce((sum, m) => sum + getContentLength(m.content), 0);
        const estimatedTokens = Math.ceil(totalChars / 3.5);
        if (estimatedTokens > contextLength * 0.8) {
          this.postMessage({
            command: 'assistantMessage',
            content: `⚠️ Warning: Your conversation (~${estimatedTokens} tokens) may exceed this model's ${contextLength} token context window. Consider switching to a model with a larger context, reducing maxFiles, or starting a new conversation.\n\n`,
          });
        }
      }

      let fullResponse = '';
      const stream = this.client.streamChat(chatMessages, this.abortController.signal);

      for await (const text of stream) {
        fullResponse += text;
        this.postMessage({ command: 'assistantMessage', content: text });
      }

      this.messages.push({ role: 'assistant', content: fullResponse });
      this.saveHistory();
      this.postMessage({ command: 'done' });

      // Check if the response contains a shell command to run
      const cmdMatch = fullResponse.match(/```(?:sh|bash|shell|zsh)\n([\s\S]*?)```/);
      if (cmdMatch) {
        const cmd = cmdMatch[1].trim();
        const output = await this.handleRunCommand(cmd);
        if (output !== null) {
          this.messages.push({ role: 'user', content: `Command output:\n\`\`\`\n${output}\n\`\`\`\nBased on this output, continue your response.` });
          this.postMessage({ command: 'commandResult', content: output });
          await this.handleUserMessage('');
          return;
        }
      }

      // Check if the response contains edit blocks
      const editBlocks = parseEditBlocks(fullResponse);
      if (editBlocks.length === 1) {
        const block = editBlocks[0];
        const result = await showDiffPreview(block, this.contentProvider);
        if (result === 'accept') {
          const success = await applyEdit(block);
          this.postMessage({
            command: 'assistantMessage',
            content: success ? `\n\n✓ Applied edit to ${block.filePath}` : `\n\n✗ Failed to apply edit to ${block.filePath}`,
          });
        } else {
          this.postMessage({ command: 'assistantMessage', content: `\n\nEdit to ${block.filePath} rejected.` });
        }
      } else if (editBlocks.length > 1) {
        const files = [...new Set(editBlocks.map(b => b.filePath))];
        const choice = await window.showWarningMessage(
          `SideCar wants to edit ${files.length} file(s) (${editBlocks.length} changes)`,
          { modal: true },
          'Apply All', 'Review Each',
        );
        if (choice === 'Apply All') {
          const result = await applyEdits(editBlocks);
          this.postMessage({
            command: 'assistantMessage',
            content: `\n\n✓ Applied ${result.applied} edit(s)${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
          });
        } else if (choice === 'Review Each') {
          for (const block of editBlocks) {
            const result = await showDiffPreview(block, this.contentProvider);
            if (result === 'accept') {
              await applyEdit(block);
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.postMessage({ command: 'error', content: `Error: ${errorMessage}` });
    } finally {
      this.abortController = null;
    }
  }

  private async handleAttachFile(): Promise<void> {
    const editor = window.activeTextEditor;

    const options: string[] = [];
    if (editor) {
      options.push('Active File: ' + path.basename(editor.document.fileName));
    }
    options.push('Browse...');

    const pick = options.length === 1
      ? options[0]
      : await window.showQuickPick(options, { placeHolder: 'Select a file to attach' });
    if (!pick) return;

    let fileName: string | undefined;
    let fileContent: string | undefined;

    if (pick.startsWith('Active File') && editor) {
      fileName = path.basename(editor.document.fileName);
      fileContent = editor.document.getText();
    } else {
      const uris = await window.showOpenDialog({ canSelectMany: false });
      if (!uris || uris.length === 0) return;
      const doc = await workspace.openTextDocument(uris[0]);
      fileName = path.basename(uris[0].fsPath);
      fileContent = doc.getText();
    }

    if (fileName && fileContent) {
      if (fileContent.length > 500_000) {
        window.showWarningMessage(`File "${fileName}" is too large to attach (>500KB).`);
        return;
      }
      this.postMessage({ command: 'fileAttached', fileName, fileContent });
    }
  }

  private async handleSaveCodeBlock(code: string, language?: string): Promise<void> {
    const ext = language ? this.languageToExtension(language) : '.txt';
    const uri = await window.showSaveDialog({
      filters: { 'All Files': ['*'] },
      defaultUri: Uri.file('untitled' + ext),
    });
    if (!uri) return;

    await workspace.fs.writeFile(uri, Buffer.from(code, 'utf-8'));
    window.showInformationMessage(`Saved to ${path.basename(uri.fsPath)}`);
  }

  private async handleCreateFile(code: string, filePath: string): Promise<void> {
    const workspaceFolders = workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.postMessage({ command: 'error', content: 'No workspace folder open.' });
      return;
    }

    const rootUri = workspaceFolders[0].uri;
    const fileUri = Uri.joinPath(rootUri, filePath);

    let exists = false;
    try {
      await workspace.fs.stat(fileUri);
      exists = true;
    } catch {
      // File doesn't exist — safe to create
    }

    if (exists) {
      const choice = await window.showWarningMessage(
        `"${filePath}" already exists. Overwrite?`,
        { modal: true },
        'Overwrite'
      );
      if (choice !== 'Overwrite') return;
    }

    try {
      await workspace.fs.createDirectory(Uri.joinPath(rootUri, path.dirname(filePath)));
      await workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf-8'));
      window.showInformationMessage(`Created ${filePath}`);
    } catch (err) {
      this.postMessage({
        command: 'error',
        content: `Failed to create file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async handleRunCommand(command: string): Promise<string | null> {
    const choice = await window.showWarningMessage(
      `SideCar wants to run: ${command}`,
      { modal: true },
      'Allow',
    );
    if (choice !== 'Allow') {
      this.postMessage({ command: 'commandResult', content: 'Command cancelled by user.' });
      return null;
    }

    // Try terminal with shell integration for output capture
    const terminalOutput = await this.terminalManager.executeCommand(command);
    if (terminalOutput !== null) {
      return terminalOutput;
    }

    // Fallback: run hidden and capture output
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

  private async handleGitHubCommand(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.action) {
        case 'clone': {
          if (!msg.url) {
            this.postMessage({ command: 'error', content: 'Please provide a repository URL.' });
            return;
          }
          const targetUris = await window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Clone Here',
          });
          if (!targetUris || targetUris.length === 0) return;
          const repoName = msg.url.replace(/\.git$/, '').split('/').pop() || 'repo';
          const targetDir = path.join(targetUris[0].fsPath, repoName);
          this.postMessage({ command: 'githubResult', githubAction: 'clone', githubData: 'Cloning...' });
          const git = new GitCLI(targetUris[0].fsPath);
          const result = await git.clone(msg.url, targetDir);
          this.postMessage({ command: 'githubResult', githubAction: 'clone', githubData: result });
          const openChoice = await window.showInformationMessage(
            `Cloned ${repoName}. Open in VSCode?`, 'Open', 'Cancel'
          );
          if (openChoice === 'Open') {
            await import('vscode').then((vsc) =>
              vsc.commands.executeCommand('vscode.openFolder', Uri.file(targetDir))
            );
          }
          break;
        }
        case 'push': {
          const git = new GitCLI();
          const result = await git.push();
          this.postMessage({ command: 'githubResult', githubAction: 'push', githubData: result });
          break;
        }
        case 'pull': {
          const git = new GitCLI();
          const result = await git.pull();
          this.postMessage({ command: 'githubResult', githubAction: 'pull', githubData: result });
          break;
        }
        case 'log': {
          const git = new GitCLI();
          const commits = await git.log(msg.count || 10);
          this.postMessage({ command: 'githubResult', githubAction: 'log', githubData: commits });
          break;
        }
        case 'diff': {
          const git = new GitCLI();
          const diff = await git.diff(msg.ref1, msg.ref2);
          this.postMessage({ command: 'githubResult', githubAction: 'diff', githubData: diff });
          break;
        }
        case 'listPRs':
        case 'getPR':
        case 'createPR':
        case 'listIssues':
        case 'getIssue':
        case 'createIssue':
        case 'browse': {
          const token = await getGitHubToken();
          const api = new GitHubAPI(token);

          let owner: string;
          let repo: string;

          if (msg.repo) {
            const parsed = GitHubAPI.parseRepo(msg.repo);
            if (!parsed) {
              this.postMessage({ command: 'error', content: 'Invalid repo format. Use owner/repo or a GitHub URL.' });
              return;
            }
            ({ owner, repo } = parsed);
          } else {
            const git = new GitCLI();
            const remoteUrl = await git.getRemoteUrl();
            if (!remoteUrl) {
              this.postMessage({ command: 'error', content: 'No GitHub remote found. Specify a repo like: /prs owner/repo' });
              return;
            }
            const parsed = GitHubAPI.parseRepo(remoteUrl);
            if (!parsed) {
              this.postMessage({ command: 'error', content: 'Could not parse remote URL as a GitHub repo.' });
              return;
            }
            ({ owner, repo } = parsed);
          }

          if (msg.action === 'listPRs') {
            const prs = await api.listPRs(owner, repo);
            this.postMessage({ command: 'githubResult', githubAction: 'listPRs', githubData: prs });
          } else if (msg.action === 'getPR') {
            const pr = await api.getPR(owner, repo, msg.number!);
            this.postMessage({ command: 'githubResult', githubAction: 'getPR', githubData: pr });
          } else if (msg.action === 'createPR') {
            if (!msg.title || !msg.head || !msg.base) {
              this.postMessage({ command: 'error', content: 'Usage: /create pr "title" base-branch head-branch' });
              return;
            }
            const pr = await api.createPR(owner, repo, msg.title, msg.head, msg.base, msg.body);
            this.postMessage({ command: 'githubResult', githubAction: 'createPR', githubData: pr });
          } else if (msg.action === 'listIssues') {
            const issues = await api.listIssues(owner, repo);
            this.postMessage({ command: 'githubResult', githubAction: 'listIssues', githubData: issues });
          } else if (msg.action === 'getIssue') {
            const issue = await api.getIssue(owner, repo, msg.number!);
            this.postMessage({ command: 'githubResult', githubAction: 'getIssue', githubData: issue });
          } else if (msg.action === 'createIssue') {
            if (!msg.title) {
              this.postMessage({ command: 'error', content: 'Usage: /create issue "title" ["body"]' });
              return;
            }
            const issue = await api.createIssue(owner, repo, msg.title, msg.body);
            this.postMessage({ command: 'githubResult', githubAction: 'createIssue', githubData: issue });
          } else if (msg.action === 'browse') {
            const files = await api.listRepoContents(owner, repo, msg.ghPath);
            this.postMessage({ command: 'githubResult', githubAction: 'browse', githubData: files });
          }
          break;
        }
      }
    } catch (err) {
      this.postMessage({
        command: 'error',
        content: `GitHub error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async handleMoveFile(sourcePath: string, destPath: string): Promise<void> {
    if (!sourcePath || !destPath) {
      this.postMessage({ command: 'error', content: 'Move requires both a source and destination path.' });
      return;
    }

    const workspaceFolders = workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.postMessage({ command: 'error', content: 'No workspace folder open.' });
      return;
    }

    const rootUri = workspaceFolders[0].uri;
    const sourceUri = path.isAbsolute(sourcePath)
      ? Uri.file(sourcePath)
      : Uri.joinPath(rootUri, sourcePath);
    const destUri = path.isAbsolute(destPath)
      ? Uri.file(destPath)
      : Uri.joinPath(rootUri, destPath);

    try {
      await workspace.fs.stat(sourceUri);
    } catch {
      this.postMessage({ command: 'error', content: `Source not found: ${sourcePath}` });
      return;
    }

    let destExists = false;
    try {
      await workspace.fs.stat(destUri);
      destExists = true;
    } catch {
      // Destination doesn't exist — safe to proceed
    }

    if (destExists) {
      const choice = await window.showWarningMessage(
        `"${destPath}" already exists. Overwrite?`,
        { modal: true },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        this.postMessage({ command: 'fileMoved', content: 'Move cancelled.' });
        return;
      }
    }

    try {
      await workspace.fs.rename(sourceUri, destUri, { overwrite: destExists });
      this.postMessage({
        command: 'fileMoved',
        content: `Moved "${sourcePath}" to "${destPath}"`,
      });
    } catch (err) {
      this.postMessage({
        command: 'error',
        content: `Failed to move file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private languageToExtension(lang: string): string {
    const map: Record<string, string> = {
      typescript: '.ts', javascript: '.js', python: '.py',
      rust: '.rs', go: '.go', java: '.java', cpp: '.cpp',
      c: '.c', html: '.html', css: '.css', json: '.json',
      yaml: '.yaml', markdown: '.md', bash: '.sh', sh: '.sh',
      sql: '.sql', tsx: '.tsx', jsx: '.jsx',
    };
    return map[lang.toLowerCase()] || '.txt';
  }

  private abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  private postMessage(message: ExtensionMessage): void {
    this.webviewView?.webview.postMessage(message);
  }
}
