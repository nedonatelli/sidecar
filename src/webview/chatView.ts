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
import { spawn } from 'child_process';
import { OllamaClient } from '../ollama/client.js';
import { getOllamaModel, getOllamaSystemPrompt } from '../config/settings.js';
import type { OllamaMessage } from '../ollama/types.js';
import { getChatWebviewHtml, type WebviewMessage, type ExtensionMessage, type LibraryModelUI } from './chatWebview.js';
import { GitCLI } from '../github/git.js';
import { GitHubAPI } from '../github/api.js';
import { getGitHubToken } from '../github/auth.js';

export class ChatViewProvider implements WebviewViewProvider {
  private webviewView: WebviewView | undefined;
  private ollamaClient: OllamaClient;
  private messages: OllamaMessage[] = [];
  private abortController: AbortController | null = null;
  private installAbortController: AbortController | null = null;

  constructor(private readonly context: ExtensionContext) {
    this.ollamaClient = new OllamaClient(getOllamaModel(), getOllamaSystemPrompt());
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
            await this.handleUserMessage(msg.text || '');
            break;
          case 'abort':
            this.abort();
            break;
          case 'changeModel':
            this.ollamaClient.updateModel(msg.model || 'llama3');
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
          case 'moveFile':
            await this.handleMoveFile(msg.sourcePath || '', msg.destPath || '');
            break;
          case 'github':
            await this.handleGitHubCommand(msg);
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

    this.loadModels();
  }

  private async isOllamaReachable(): Promise<boolean> {
    try {
      const response = await fetch('http://localhost:11434/api/tags');
      return response.ok;
    } catch {
      return false;
    }
  }

  private async ensureOllamaRunning(): Promise<boolean> {
    if (await this.isOllamaReachable()) return true;

    // Try to start ollama serve
    try {
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch {
      return false;
    }

    // Wait for it to become reachable (up to 15 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.isOllamaReachable()) return true;
    }

    return false;
  }

  private async loadModels(): Promise<void> {
    try {
      const started = await this.ensureOllamaRunning();
      if (!started) {
        this.postMessage({
          command: 'error',
          content: 'Cannot start Ollama. Make sure Ollama is installed and in your PATH.',
        });
        return;
      }

      const libraryModels = await this.ollamaClient.listLibraryModels();
      const currentModel = getOllamaModel();

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
        content: 'Cannot connect to Ollama. Make sure Ollama is running on localhost:11434.',
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

      for await (const progress of this.ollamaClient.pullModel(modelName, this.installAbortController.signal)) {
        this.postMessage({
          command: 'installProgress',
          modelName,
          progress: progress.status,
        });
      }

      this.ollamaClient.updateModel(modelName);
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

  private async handleUserMessage(text: string): Promise<void> {
    this.messages.push({ role: 'user', content: text });
    this.postMessage({ command: 'setLoading', isLoading: true });

    this.abortController = new AbortController();

    try {
      const started = await this.ensureOllamaRunning();
      if (!started) {
        this.postMessage({ command: 'error', content: 'Ollama is not running and could not be started.' });
        return;
      }

      const model = getOllamaModel();
      const systemPrompt = getOllamaSystemPrompt();
      this.ollamaClient.updateModel(model);
      this.ollamaClient.updateSystemPrompt(systemPrompt);

      let fullResponse = '';
      const stream = this.ollamaClient.streamChat(this.messages, this.abortController.signal);

      for await (const chunk of stream) {
        fullResponse += chunk.message.content;
        this.postMessage({ command: 'assistantMessage', content: chunk.message.content });
      }

      this.messages.push({ role: 'assistant', content: fullResponse });
      this.postMessage({ command: 'done' });
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
