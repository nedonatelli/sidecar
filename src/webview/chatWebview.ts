import type { Webview } from 'vscode';
import { Uri } from 'vscode';
import type { ChatMessage } from '../ollama/types.js';
import * as crypto from 'crypto';

export interface WebviewMessage {
  command:
    | 'userMessage'
    | 'abort'
    | 'changeModel'
    | 'installModel'
    | 'cancelInstall'
    | 'attachFile'
    | 'saveCodeBlock'
    | 'createFile'
    | 'runCommand'
    | 'moveFile'
    | 'github'
    | 'openExternal'
    | 'openSettings'
    | 'newChat'
    | 'exportChat'
    | 'undoChanges'
    | 'executePlan'
    | 'revisePlan'
    | 'batch'
    | 'saveSession'
    | 'loadSession'
    | 'deleteSession'
    | 'listSessions'
    | 'insight'
    | 'spec'
    | 'generateDoc'
    | 'changeAgentMode'
    | 'confirmResponse'
    | 'scanStaged'
    | 'usage'
    | 'context'
    | 'generateTests'
    | 'lint'
    | 'deps'
    | 'scaffold'
    | 'generateCommit'
    | 'revertFile'
    | 'acceptAllChanges'
    | 'deleteMessage'
    | 'toggleVerbose'
    | 'togglePlanMode'
    | 'compactContext'
    | 'showSystemPrompt'
    | 'reconnect'
    | 'dismissOnboarding'
    | 'getSkillsForMenu';
  images?: { mediaType: string; data: string }[];
  text?: string;
  model?: string;
  agentMode?: string;
  confirmId?: string;
  confirmed?: boolean;
  code?: string;
  language?: string;
  filePath?: string;
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
  index?: number;
  tag?: string;
  draft?: boolean;
  prerelease?: boolean;
  generateNotes?: boolean;
}

export interface ExtensionMessage {
  command:
    | 'init'
    | 'assistantMessage'
    | 'error'
    | 'done'
    | 'setLoading'
    | 'setModels'
    | 'setCurrentModel'
    | 'installProgress'
    | 'installComplete'
    | 'fileAttached'
    | 'imageAttached'
    | 'fileMoved'
    | 'githubResult'
    | 'commandResult'
    | 'chatCleared'
    | 'addUserMessage'
    | 'toolCall'
    | 'toolResult'
    | 'toolOutput'
    | 'setAgentMode'
    | 'thinking'
    | 'planReady'
    | 'batchStart'
    | 'batchTaskUpdate'
    | 'batchDone'
    | 'sessionList'
    | 'agentProgress'
    | 'confirm'
    | 'dismissConfirm'
    | 'changeSummary'
    | 'verboseLog'
    | 'typingStatus'
    | 'onboarding'
    | 'skillsMenu';
  agentMode?: string;
  toolName?: string;
  toolCallId?: string;
  confirmId?: string;
  confirmActions?: string[];
  supportsTools?: boolean;
  iteration?: number;
  maxIterations?: number;
  elapsedMs?: number;
  estimatedTokens?: number;
  messageCount?: number;
  messagesRemaining?: number;
  atCapacity?: boolean;
  errorType?: 'connection' | 'auth' | 'model' | 'timeout' | 'unknown';
  errorAction?: string;
  errorActionCommand?: string;
  content?: string;
  messages?: ChatMessage[];
  isLoading?: boolean;
  models?: LibraryModelUI[];
  currentModel?: string;
  modelName?: string;
  progress?: string;
  fileName?: string;
  fileContent?: string;
  githubAction?: string;
  githubData?: unknown;
  mediaType?: string;
  data?: string;
  changeSummary?: { filePath: string; diff: string; isNew: boolean; isDeleted: boolean }[];
  expandThinking?: boolean;
  verboseLabel?: string;
  skills?: { id: string; name: string; description: string }[];
}

export interface LibraryModelUI {
  name: string;
  installed: boolean;
  supportsTools?: boolean;
}

export function getChatWebviewHtml(webview: Webview, extensionUri: Uri): string {
  const stylesUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'chat.css'));
  const scriptUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'chat.js'));
  const mermaidUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'mermaid.min.js'));
  const nonce = crypto.randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-eval'; img-src ${webview.cspSource} data: blob:; connect-src http://localhost:* https://localhost:*;">
  <link rel="stylesheet" href="${stylesUri}">
</head>
<body>
  <div id="header">
    <div id="current-model">
      <button id="model-btn" aria-haspopup="true" aria-expanded="false" aria-label="Select model">
        <span id="model-name">Loading...</span>
        <span id="model-arrow">&#9662;</span>
      </button>
      <span id="chat-only-badge" class="hidden" title="This model does not support tool calling">
        <span class="chat-only-icon">ℹ️</span>
        <span class="chat-only-text">Chat-Only</span>
      </span>
    </div>
    <select id="agent-mode-select" class="agent-mode-select" aria-label="Agent mode">
      <option value="cautious">cautious</option>
      <option value="autonomous">autonomous</option>
      <option value="manual">manual</option>
    </select>
    <div id="chat-actions">
      <button id="new-chat-btn" title="New Chat">+</button>
      <button id="history-btn" title="Conversation History">&#9776;</button>
      <button id="compact-btn" title="Compact Context">&#9986;</button>
      <button id="undo-btn" title="Undo All Changes">&#8634;</button>
      <button id="export-btn" title="Export as Markdown">&#8681;</button>
    </div>
  </div>
  <div id="activity-bar" class="hidden"></div>
  <div id="model-panel" class="hidden" role="dialog" aria-label="Model picker">
    <div id="model-panel-header">
      <span>Select Model</span>
      <button id="close-panel">&times;</button>
    </div>
    <div id="custom-model-row">
      <input id="custom-model-input" type="text" placeholder="Model name or HuggingFace URL..." />
      <button id="custom-model-use">Use</button>
    </div>
    <div id="model-list"></div>
  </div>
  <div id="sessions-panel" class="hidden" role="dialog" aria-label="Conversation history">
    <div id="sessions-panel-header">
      <span>Conversations</span>
      <button id="close-sessions">&times;</button>
    </div>
    <div id="sessions-list"></div>
    <div id="sessions-empty" class="hidden">No saved conversations. Use <code>/save &lt;name&gt;</code> to save one.</div>
  </div>
  <div id="messages" role="log" aria-live="polite"></div>
  <button id="scroll-to-bottom" class="hidden" title="Scroll to bottom">&#8595;</button>
  <div id="agent-progress" class="hidden">
    <span id="progress-step"></span>
    <span id="progress-time"></span>
    <span id="progress-tokens"></span>
  </div>
  <div id="stream-stats" class="hidden"></div>
  <div id="install-progress" class="hidden">
    <span id="install-text">Installing...</span>
    <button id="cancel-install">Cancel</button>
  </div>
  <div id="file-attachment" class="hidden">
    <span id="file-attachment-name"></span>
    <button id="remove-attachment">&times;</button>
  </div>
  <div id="image-preview" class="hidden"></div>
  <div id="slash-autocomplete" class="hidden" role="listbox" aria-label="Slash commands"></div>
  <div id="input-area">
    <button id="attach-btn" title="Attach file">&#128206;</button>
    <textarea id="input" rows="1" placeholder="Ask SideCar..."></textarea>
    <button id="send">Send</button>
  </div>

  <script nonce="${nonce}">window.__mermaidSrc = "${mermaidUri}"; window.__nonce = "${nonce}";</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
