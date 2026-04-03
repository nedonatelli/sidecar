import type { Webview } from 'vscode';
import { Uri } from 'vscode';
import type { OllamaMessage } from '../ollama/types.js';
import * as crypto from 'crypto';

export interface WebviewMessage {
  command: 'userMessage' | 'abort' | 'changeModel' | 'installModel' | 'cancelInstall' | 'attachFile' | 'saveCodeBlock' | 'moveFile' | 'github' | 'openExternal';
  text?: string;
  model?: string;
  code?: string;
  language?: string;
  sourcePath?: string;
  destPath?: string;
  action?: string;
  url?: string;
  repo?: string;
  number?: number;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  ref1?: string;
  ref2?: string;
  ghPath?: string;
  count?: number;
}

export interface ExtensionMessage {
  command: 'init' | 'assistantMessage' | 'error' | 'done' | 'setLoading' | 'setModels' | 'setCurrentModel' | 'installProgress' | 'installComplete' | 'fileAttached' | 'fileMoved' | 'githubResult';
  content?: string;
  messages?: OllamaMessage[];
  isLoading?: boolean;
  models?: LibraryModelUI[];
  currentModel?: string;
  modelName?: string;
  progress?: string;
  installingModel?: string;
  fileName?: string;
  fileContent?: string;
  githubAction?: string;
  githubData?: unknown;
}

export interface LibraryModelUI {
  name: string;
  installed: boolean;
}

export function getChatWebviewHtml(
  webview: Webview,
  extensionUri: Uri
): string {
  const stylesUri = webview.asWebviewUri(
    Uri.joinPath(extensionUri, 'media', 'chat.css')
  );
  const nonce = crypto.randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:; connect-src http://localhost:* https://localhost:*;">
  <link rel="stylesheet" href="${stylesUri}">
</head>
<body>
  <div id="header">
    <div id="current-model">
      <span id="model-btn">
        <span id="model-name">Loading...</span>
        <span id="model-arrow">&#9662;</span>
      </span>
    </div>
  </div>
  <div id="model-panel" class="hidden">
    <div id="model-panel-header">
      <span>Select Model</span>
      <button id="close-panel">&times;</button>
    </div>
    <div id="custom-model-row">
      <input id="custom-model-input" type="text" placeholder="Enter model name..." />
      <button id="custom-model-use">Use</button>
    </div>
    <div id="model-list"></div>
  </div>
  <div id="messages"></div>
  <div id="install-progress" class="hidden">
    <span id="install-text">Installing...</span>
    <button id="cancel-install">Cancel</button>
  </div>
  <div id="file-attachment" class="hidden">
    <span id="file-attachment-name"></span>
    <button id="remove-attachment">&times;</button>
  </div>
  <div id="input-area">
    <button id="attach-btn" title="Attach file">&#128206;</button>
    <textarea id="input" rows="1" placeholder="Ask SideCar..."></textarea>
    <button id="send">Send</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesContainer = document.getElementById('messages');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const attachBtn = document.getElementById('attach-btn');
    const modelBtn = document.getElementById('model-btn');
    const modelName = document.getElementById('model-name');
    const modelPanel = document.getElementById('model-panel');
    const modelList = document.getElementById('model-list');
    const closePanel = document.getElementById('close-panel');
    const installProgress = document.getElementById('install-progress');
    const installText = document.getElementById('install-text');
    const cancelInstall = document.getElementById('cancel-install');
    const fileAttachment = document.getElementById('file-attachment');
    const fileAttachmentName = document.getElementById('file-attachment-name');
    const removeAttachment = document.getElementById('remove-attachment');
    const customModelInput = document.getElementById('custom-model-input');
    const customModelUse = document.getElementById('custom-model-use');

    let isLoading = false;
    let currentAssistantDiv = null;
    let currentAssistantText = '';
    let installingModel = null;
    let pendingFile = null;

    modelBtn.addEventListener('click', () => {
      modelPanel.classList.toggle('hidden');
    });

    closePanel.addEventListener('click', () => {
      modelPanel.classList.add('hidden');
    });

    cancelInstall.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancelInstall' });
    });

    attachBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'attachFile' });
    });

    removeAttachment.addEventListener('click', () => {
      pendingFile = null;
      fileAttachment.classList.add('hidden');
    });

    customModelUse.addEventListener('click', () => {
      const name = customModelInput.value.trim();
      if (!name) return;
      vscode.postMessage({ command: 'changeModel', model: name });
      customModelInput.value = '';
      modelPanel.classList.add('hidden');
    });

    customModelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        customModelUse.click();
      }
    });

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    // Enter to send, Shift+Enter for newline
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitMessage();
      }
    });

    sendBtn.addEventListener('click', submitMessage);

    function tryParseMoveCommand(text) {
      // /move source dest
      const slashMatch = text.match(/^\\/move\\s+("([^"]+)"|([^\\s]+))\\s+("([^"]+)"|([^\\s]+))\\s*$/i);
      if (slashMatch) {
        return { source: slashMatch[2] || slashMatch[3], dest: slashMatch[5] || slashMatch[6] };
      }
      // move file "source" to "dest"  (quotes optional)
      const naturalMatch = text.match(/^move\\s+file\\s+("([^"]+)"|([^\\s]+))\\s+to\\s+("([^"]+)"|([^\\s]+))\\s*$/i);
      if (naturalMatch) {
        return { source: naturalMatch[2] || naturalMatch[3], dest: naturalMatch[5] || naturalMatch[6] };
      }
      // rename file "source" to "dest"
      const renameMatch = text.match(/^rename\\s+file\\s+("([^"]+)"|([^\\s]+))\\s+to\\s+("([^"]+)"|([^\\s]+))\\s*$/i);
      if (renameMatch) {
        return { source: renameMatch[2] || renameMatch[3], dest: renameMatch[5] || renameMatch[6] };
      }
      return null;
    }

    function tryParseGitHubCommand(text) {
      // /clone <url> or clone repo <url>
      let m = text.match(/^(?:\\/clone|clone\\s+repo)\\s+(.+?)\\s*$/i);
      if (m) return { action: 'clone', url: m[1] };

      // /push or push changes
      if (/^(?:\\/push|push\\s+changes?)\\s*$/i.test(text)) return { action: 'push' };

      // /pull or pull changes
      if (/^(?:\\/pull|pull\\s+changes?)\\s*$/i.test(text)) return { action: 'pull' };

      // /log [N] or show commits [N]
      m = text.match(/^(?:\\/log|show\\s+commits?)(?:\\s+(\\d+))?\\s*$/i);
      if (m) return { action: 'log', count: m[1] ? parseInt(m[1]) : undefined };

      // /diff [ref1] [ref2] or show diff [ref1] [ref2]
      m = text.match(/^(?:\\/diff|show\\s+diff)(?:\\s+(\\S+))?(?:\\s+(\\S+))?\\s*$/i);
      if (m) return { action: 'diff', ref1: m[1], ref2: m[2] };

      // /prs [repo] or show prs [repo] or list prs [repo]
      m = text.match(/^(?:\\/prs|(?:show|list)\\s+prs?)(?:\\s+(.+?))?\\s*$/i);
      if (m) return { action: 'listPRs', repo: m[1] };

      // /pr <number> or show pr #<number>
      m = text.match(/^(?:\\/pr|show\\s+pr)\\s+#?(\\d+)(?:\\s+(.+?))?\\s*$/i);
      if (m) return { action: 'getPR', number: parseInt(m[1]), repo: m[2] };

      // /create pr "title" base head [body] or create pr "title" base head
      m = text.match(/^(?:\\/create\\s+pr|create\\s+pr)\\s+"([^"]+)"\\s+(\\S+)\\s+(\\S+)(?:\\s+"([^"]*)")?\\s*$/i);
      if (m) return { action: 'createPR', title: m[1], base: m[2], head: m[3], body: m[4] };

      // /issues [repo] or show issues [repo] or list issues [repo]
      m = text.match(/^(?:\\/issues|(?:show|list)\\s+issues?)(?:\\s+(.+?))?\\s*$/i);
      if (m) return { action: 'listIssues', repo: m[1] };

      // /issue <number> or show issue #<number>
      m = text.match(/^(?:\\/issue|show\\s+issue)\\s+#?(\\d+)(?:\\s+(.+?))?\\s*$/i);
      if (m) return { action: 'getIssue', number: parseInt(m[1]), repo: m[2] };

      // /create issue "title" ["body"] or create issue "title" ["body"]
      m = text.match(/^(?:\\/create\\s+issue|create\\s+issue)\\s+"([^"]+)"(?:\\s+"([^"]*)")?\\s*$/i);
      if (m) return { action: 'createIssue', title: m[1], body: m[2] };

      // /browse [path] [repo] or browse repo [path]
      m = text.match(/^(?:\\/browse|browse\\s+repo(?:\\s+files?)?)(?:\\s+(\\S+))?\\s*$/i);
      if (m) return { action: 'browse', ghPath: m[1] };

      return null;
    }

    function renderGitHubResult(action, data) {
      const container = document.createElement('div');
      container.className = 'message assistant gh-result';

      if (action === 'listPRs' || action === 'listIssues') {
        const items = data;
        if (!items || items.length === 0) {
          container.textContent = action === 'listPRs' ? 'No pull requests found.' : 'No issues found.';
          return container;
        }
        for (const item of items) {
          const card = document.createElement('div');
          card.className = 'gh-card';

          const title = document.createElement('div');
          title.className = 'gh-card-title';
          const prefix = action === 'listPRs' ? 'PR' : 'Issue';
          title.textContent = prefix + ' #' + item.number + ': ' + item.title;

          const state = document.createElement('span');
          state.className = 'gh-state ' + item.state;
          state.textContent = item.state;
          title.appendChild(document.createTextNode(' '));
          title.appendChild(state);

          const meta = document.createElement('div');
          meta.className = 'gh-meta';
          meta.textContent = 'by ' + item.author + ' - ' + new Date(item.createdAt).toLocaleDateString();

          const link = document.createElement('span');
          link.className = 'gh-link';
          link.textContent = item.url;
          link.addEventListener('click', () => {
            vscode.postMessage({ command: 'openExternal', url: item.url });
          });

          card.appendChild(title);
          card.appendChild(meta);
          card.appendChild(link);
          container.appendChild(card);
        }
        return container;
      }

      if (action === 'getPR' || action === 'getIssue') {
        const item = data;
        const prefix = action === 'getPR' ? 'PR' : 'Issue';
        const card = document.createElement('div');
        card.className = 'gh-card';

        const title = document.createElement('div');
        title.className = 'gh-card-title';
        title.textContent = prefix + ' #' + item.number + ': ' + item.title;

        const state = document.createElement('span');
        state.className = 'gh-state ' + item.state;
        state.textContent = item.state;
        title.appendChild(document.createTextNode(' '));
        title.appendChild(state);

        const meta = document.createElement('div');
        meta.className = 'gh-meta';
        meta.textContent = 'by ' + item.author + ' - ' + new Date(item.createdAt).toLocaleDateString();

        card.appendChild(title);
        card.appendChild(meta);

        if (item.body) {
          const body = document.createElement('div');
          body.className = 'gh-body';
          body.textContent = item.body.slice(0, 500) + (item.body.length > 500 ? '...' : '');
          card.appendChild(body);
        }

        if (action === 'getPR' && item.head && item.base) {
          const branches = document.createElement('div');
          branches.className = 'gh-meta';
          branches.textContent = item.head + ' → ' + item.base;
          card.appendChild(branches);
        }

        if (item.labels && item.labels.length > 0) {
          const labels = document.createElement('div');
          labels.className = 'gh-meta';
          labels.textContent = 'Labels: ' + item.labels.join(', ');
          card.appendChild(labels);
        }

        const link = document.createElement('span');
        link.className = 'gh-link';
        link.textContent = item.url;
        link.addEventListener('click', () => {
          vscode.postMessage({ command: 'openExternal', url: item.url });
        });
        card.appendChild(link);

        container.appendChild(card);
        return container;
      }

      if (action === 'createPR' || action === 'createIssue') {
        const item = data;
        const prefix = action === 'createPR' ? 'PR' : 'Issue';
        container.textContent = prefix + ' #' + item.number + ' created: ' + item.title;
        const link = document.createElement('span');
        link.className = 'gh-link';
        link.textContent = ' ' + item.url;
        link.addEventListener('click', () => {
          vscode.postMessage({ command: 'openExternal', url: item.url });
        });
        container.appendChild(link);
        return container;
      }

      if (action === 'log') {
        const commits = data;
        if (!commits || commits.length === 0) {
          container.textContent = 'No commits found.';
          return container;
        }
        for (const c of commits) {
          const row = document.createElement('div');
          row.className = 'gh-commit';
          const hash = document.createElement('span');
          hash.className = 'gh-commit-hash';
          hash.textContent = c.hash;
          const msg = document.createTextNode('  ' + c.message + '  ');
          const meta = document.createElement('span');
          meta.className = 'gh-meta-inline';
          meta.textContent = '(' + c.author + ', ' + c.date + ')';
          row.appendChild(hash);
          row.appendChild(msg);
          row.appendChild(meta);
          container.appendChild(row);
        }
        return container;
      }

      if (action === 'diff') {
        const result = data;
        const summary = document.createElement('div');
        summary.className = 'gh-meta';
        summary.textContent = result.summary;
        container.appendChild(summary);
        if (result.diff && result.diff !== 'No diff output.') {
          container.appendChild(renderContent('\`\`\`diff\\n' + result.diff + '\\n\`\`\`'));
        }
        return container;
      }

      if (action === 'browse') {
        const files = data;
        if (!files || files.length === 0) {
          container.textContent = 'No files found.';
          return container;
        }
        for (const f of files) {
          const row = document.createElement('div');
          row.className = 'gh-file-item';
          const icon = f.type === 'dir' ? '📁 ' : '📄 ';
          const link = document.createElement('span');
          link.className = 'gh-link';
          link.textContent = icon + f.name;
          link.addEventListener('click', () => {
            vscode.postMessage({ command: 'openExternal', url: f.url });
          });
          row.appendChild(link);
          container.appendChild(row);
        }
        return container;
      }

      // Fallback: plain text
      container.textContent = typeof data === 'string' ? data : JSON.stringify(data);
      return container;
    }

    function submitMessage() {
      const text = input.value.trim();
      if (!text || isLoading) return;

      // Check for move/rename commands
      const moveCmd = tryParseMoveCommand(text);
      if (moveCmd) {
        appendMessage('user', text);
        vscode.postMessage({ command: 'moveFile', sourcePath: moveCmd.source, destPath: moveCmd.dest });
        input.value = '';
        input.style.height = 'auto';
        return;
      }

      // Check for GitHub commands
      const ghCmd = tryParseGitHubCommand(text);
      if (ghCmd) {
        appendMessage('user', text);
        vscode.postMessage({ command: 'github', ...ghCmd });
        input.value = '';
        input.style.height = 'auto';
        return;
      }

      let messageText = text;
      let displayText = text;

      if (pendingFile) {
        messageText = '[File: ' + pendingFile.fileName + ']\\n\`\`\`\\n' + pendingFile.fileContent + '\\n\`\`\`\\n\\n' + text;
        displayText = text;
        const div = appendMessage('user', displayText);
        const label = document.createElement('span');
        label.className = 'attachment-label';
        label.textContent = 'Attached: ' + pendingFile.fileName;
        div.appendChild(label);
        pendingFile = null;
        fileAttachment.classList.add('hidden');
      } else {
        appendMessage('user', displayText);
      }

      vscode.postMessage({ command: 'userMessage', text: messageText });
      input.value = '';
      input.style.height = 'auto';
    }

    function renderContent(text) {
      const fragment = document.createDocumentFragment();
      const codeBlockRegex = /\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g;
      let lastIndex = 0;
      let match;

      while ((match = codeBlockRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          const span = document.createElement('span');
          span.textContent = text.slice(lastIndex, match.index);
          fragment.appendChild(span);
        }

        const lang = match[1];
        const code = match[2];
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block';

        const header = document.createElement('div');
        header.className = 'code-block-header';
        header.appendChild(document.createTextNode(lang || 'code'));

        const saveBtn = document.createElement('button');
        saveBtn.className = 'code-save-btn';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => {
          vscode.postMessage({ command: 'saveCodeBlock', code, language: lang });
        });
        header.appendChild(saveBtn);

        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        codeEl.textContent = code;
        pre.appendChild(codeEl);

        wrapper.appendChild(header);
        wrapper.appendChild(pre);
        fragment.appendChild(wrapper);

        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < text.length) {
        const span = document.createElement('span');
        span.textContent = text.slice(lastIndex);
        fragment.appendChild(span);
      }

      return fragment;
    }

    function appendMessage(role, content, isError = false) {
      const div = document.createElement('div');
      div.className = 'message ' + role + (isError ? ' error' : '');
      if (role === 'assistant' && !isError) {
        div.appendChild(renderContent(content));
      } else {
        div.textContent = content;
      }
      messagesContainer.appendChild(div);
      scrollToBottom();
      return div;
    }

    function startAssistantMessage() {
      currentAssistantText = '';
      currentAssistantDiv = document.createElement('div');
      currentAssistantDiv.className = 'message assistant';
      messagesContainer.appendChild(currentAssistantDiv);
      scrollToBottom();
      return currentAssistantDiv;
    }

    function appendToAssistantMessage(content) {
      if (currentAssistantDiv) {
        currentAssistantText += content;
        currentAssistantDiv.innerHTML = '';
        currentAssistantDiv.appendChild(renderContent(currentAssistantText));
        scrollToBottom();
      }
    }

    function finishAssistantMessage() {
      currentAssistantDiv = null;
      currentAssistantText = '';
    }

    function showTypingIndicator() {
      const div = document.createElement('div');
      div.className = 'message assistant typing-indicator';
      div.id = 'typing';
      div.innerHTML = '<span></span><span></span><span></span>';
      messagesContainer.appendChild(div);
      scrollToBottom();
    }

    function removeTypingIndicator() {
      const typing = document.getElementById('typing');
      if (typing) typing.remove();
    }

    function setLoading(loading) {
      isLoading = loading;
      sendBtn.disabled = loading;
      sendBtn.classList.toggle('loading', loading);
      input.disabled = loading;
    }

    function scrollToBottom() {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function renderModelList(models) {
      modelList.innerHTML = '';
      for (const model of models) {
        const item = document.createElement('div');
        item.className = 'model-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'model-item-name';
        nameSpan.textContent = model.name;

        if (model.installed) {
          nameSpan.classList.add('installed');
          const checkmark = document.createElement('span');
          checkmark.className = 'model-check';
          checkmark.textContent = '\\u2713';
          nameSpan.appendChild(checkmark);
        } else {
          const badge = document.createElement('span');
          badge.className = 'model-badge';
          badge.textContent = 'not installed';
          nameSpan.appendChild(badge);
        }

        const actionBtn = document.createElement('button');
        if (model.installed) {
          actionBtn.textContent = 'Use';
          actionBtn.className = 'model-action use';
        } else if (installingModel === model.name) {
          actionBtn.textContent = 'Installing...';
          actionBtn.className = 'model-action installing';
          actionBtn.disabled = true;
        } else {
          actionBtn.textContent = 'Install';
          actionBtn.className = 'model-action install';
        }
        actionBtn.dataset.model = model.name;

        actionBtn.addEventListener('click', () => {
          if (model.installed) {
            vscode.postMessage({ command: 'changeModel', model: model.name });
            modelPanel.classList.add('hidden');
          } else if (installingModel !== model.name) {
            vscode.postMessage({ command: 'installModel', model: model.name });
          }
        });

        item.appendChild(nameSpan);
        item.appendChild(actionBtn);
        modelList.appendChild(item);
      }
    }

    // Handle messages from extension
    window.addEventListener('message', event => {
      const { command, content } = event.data;

      switch (command) {
        case 'init':
          if (event.data.messages) {
            for (const msg of event.data.messages) {
              appendMessage(msg.role, msg.content);
            }
          }
          break;

        case 'setLoading':
          setLoading(event.data.isLoading);
          if (event.data.isLoading) {
            showTypingIndicator();
          } else {
            removeTypingIndicator();
          }
          break;

        case 'assistantMessage':
          if (!currentAssistantDiv) {
            removeTypingIndicator();
            startAssistantMessage();
          }
          appendToAssistantMessage(content || '');
          break;

        case 'done':
          finishAssistantMessage();
          setLoading(false);
          break;

        case 'setModels':
          renderModelList(event.data.models || []);
          break;

        case 'setCurrentModel':
          modelName.textContent = event.data.currentModel || 'Select Model';
          modelPanel.classList.add('hidden');
          break;

        case 'installProgress':
          installingModel = event.data.modelName;
          installProgress.classList.remove('hidden');
          installText.textContent = 'Installing ' + event.data.modelName + (event.data.progress ? ': ' + event.data.progress : '...');
          if (event.data.models) {
            renderModelList(event.data.models);
          }
          break;

        case 'installComplete':
          installingModel = null;
          installProgress.classList.add('hidden');
          if (event.data.models) {
            renderModelList(event.data.models);
          }
          break;

        case 'fileAttached':
          pendingFile = { fileName: event.data.fileName, fileContent: event.data.fileContent };
          fileAttachmentName.textContent = 'Attached: ' + event.data.fileName;
          fileAttachment.classList.remove('hidden');
          break;

        case 'fileMoved':
          appendMessage('assistant', content || 'File moved.');
          break;

        case 'githubResult': {
          const resultEl = renderGitHubResult(event.data.githubAction, event.data.githubData);
          messagesContainer.appendChild(resultEl);
          scrollToBottom();
          break;
        }

        case 'error':
          removeTypingIndicator();
          if (currentAssistantDiv) {
            currentAssistantDiv.remove();
            currentAssistantDiv = null;
            currentAssistantText = '';
          }
          appendMessage('assistant', content || 'An error occurred', true);
          setLoading(false);
          break;
      }
    });
  </script>
</body>
</html>`;
}
