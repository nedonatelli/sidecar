import type { Webview } from 'vscode';
import { Uri } from 'vscode';
import type { ChatMessage } from '../ollama/types.js';
import { getConfig, BUILT_IN_BACKEND_PROFILES, detectActiveProfile } from '../config/settings.js';
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
    | 'clarifyResponse'
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
    | 'compactContext'
    | 'showSystemPrompt'
    | 'reconnect'
    | 'dismissOnboarding'
    | 'getSkillsForMenu'
    | 'audit'
    | 'insights'
    | 'explainToolDecision'
    | 'mcpStatus'
    | 'initProject'
    | 'bgStart'
    | 'bgStop'
    | 'bgList'
    | 'bgExpand'
    | 'forkStart'
    | 'switchBackend'
    | 'kickstandLoad'
    | 'kickstandUnload'
    | 'reviewChanges'
    | 'prSummary'
    | 'createDraftPR'
    | 'analyzeCi'
    | 'reviewPrComments'
    | 'respondPrComments'
    | 'markPrReady'
    | 'checkPrCi'
    | 'commitMessage'
    | 'listMemories'
    | 'searchMemories'
    | 'droppedPaths'
    | 'steerEnqueue'
    | 'steerCancel'
    | 'steerEdit'
    | 'resume'
    | 'executeExtensionCommand';
  images?: { mediaType: string; data: string }[];
  text?: string;
  model?: string;
  agentMode?: string;
  confirmId?: string;
  confirmed?: boolean;
  profileId?: string;
  modelId?: string;
  code?: string;
  language?: string;
  filePath?: string;
  sourcePath?: string;
  destPath?: string;
  action?: import('../github/types.js').GitHubAction;
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
  toolCallId?: string;
  /** Command ID for 'executeExtensionCommand'. Must be in the handler's allowlist. */
  commandId?: string;
  /** Arguments forwarded to the command for 'executeExtensionCommand'. */
  args?: unknown[];
  /** Filesystem paths dropped into the chat webview. */
  paths?: string[];
  /** Steer queue: the id of a pending steer for cancel/edit. */
  steerId?: string;
  /** Steer queue: urgency for a new submission. */
  steerUrgency?: 'nudge' | 'interrupt';
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
    | 'filesAttached'
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
    | 'clarify'
    | 'changeSummary'
    | 'verboseLog'
    | 'typingStatus'
    | 'onboarding'
    | 'skillsMenu'
    | 'suggestNextSteps'
    | 'bgStatusUpdate'
    | 'bgOutput'
    | 'bgComplete'
    | 'bgList'
    | 'resumeAvailable'
    | 'steerQueueUpdate'
    | 'editPlanCard'
    | 'editPlanProgress'
    | 'uiSettings'
    | 'injectPrompt';
  agentMode?: string;
  toolName?: string;
  toolCallId?: string;
  confirmId?: string;
  confirmActions?: string[];
  clarifyId?: string;
  clarifyOptions?: string[];
  clarifyAllowCustom?: boolean;
  supportsTools?: boolean;
  iteration?: number;
  maxIterations?: number;
  elapsedMs?: number;
  estimatedTokens?: number;
  messageCount?: number;
  messagesRemaining?: number;
  atCapacity?: boolean;
  errorType?:
    | 'connection'
    | 'auth'
    | 'model'
    | 'timeout'
    | 'rate_limit'
    | 'server_error'
    | 'content_policy'
    | 'token_limit'
    | 'unknown';
  errorAction?: string;
  errorActionCommand?: string;
  errorModel?: string;
  content?: string;
  messages?: ChatMessage[];
  isLoading?: boolean;
  models?: LibraryModelUI[];
  currentModel?: string;
  modelName?: string;
  progress?: string;
  percent?: number;
  fileName?: string;
  fileContent?: string;
  /** Batch of files from a drag-drop or multi-select attach. */
  files?: { fileName: string; fileContent: string }[];
  githubAction?: import('../github/types.js').GitHubAction;
  githubData?: unknown;
  mediaType?: string;
  data?: string;
  changeSummary?: { filePath: string; diff: string; isNew: boolean; isDeleted: boolean }[];
  expandThinking?: boolean;
  chatDensity?: 'compact' | 'normal' | 'comfortable';
  chatFontSize?: number;
  chatAccentColor?: string;
  verboseLabel?: string;
  skills?: { id: string; name: string; description: string }[];
  suggestions?: string[];
  customModes?: { name: string; description: string }[];
  bgRun?: {
    id: string;
    task: string;
    status: string;
    startedAt: number;
    completedAt?: number;
    output: string;
    error?: string;
    toolCalls: number;
  };
  bgRuns?: {
    id: string;
    task: string;
    status: string;
    startedAt: number;
    completedAt?: number;
    output: string;
    error?: string;
    toolCalls: number;
  }[];
  bgRunId?: string;
  /**
   * Steer count carried on `resumeAvailable` so the persistent resume
   * strip (v0.65 chunk 7b) can show "(+N queued steers)" and the user
   * knows their queued intent will ride along on resume.
   */
  steerCount?: number;
  /**
   * Steer-queue snapshot broadcast to the webview whenever the queue
   * mutates (enqueue / cancel / edit / drain / clear). The strip UI
   * re-renders from this list — no client-side state synthesis.
   * Empty array clears the strip.
   */
  steerQueue?: { id: string; text: string; urgency: 'nudge' | 'interrupt'; createdAt: number }[];
  /**
   * Whether a steer-queue-attached agent run is currently active. Lets
   * the webview enable/disable the steer strip — no point showing it
   * when the user isn't mid-run.
   */
  steerEnabled?: boolean;
  /**
   * Planned Edits card payload (v0.65 chunk 4.4a). Fires once per
   * eligible multi-file turn, before the plan executes, so the user
   * sees the declared scope + dependency DAG before writes land. The
   * card is informational — to amend the plan, the user queues a steer
   * nudge that lands at the next iteration boundary.
   */
  editPlan?: {
    edits: { path: string; op: 'create' | 'edit' | 'delete'; rationale: string; dependsOn: string[] }[];
  };
  /**
   * Per-file status transition on an active Planned Edits card (v0.66
   * chunk 1, slim 4.4b). Webview finds the card row by `path` and
   * updates its status glyph + optional error-message tooltip.
   */
  editProgress?: {
    path: string;
    status: 'pending' | 'writing' | 'done' | 'failed' | 'aborted';
    errorMessage?: string;
  };
}

export interface LibraryModelUI {
  name: string;
  installed: boolean;
  supportsTools?: boolean;
  /** Context window in tokens, when the backend exposes it (e.g., Kickstand). */
  contextLength?: number | null;
}

export function getChatWebviewHtml(webview: Webview, extensionUri: Uri): string {
  const stylesUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'chat.css'));
  const scriptUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'chat.js'));
  const githubCardsUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'chat', 'githubCards.js'));
  // Mermaid: the 5.2MB bundle is already lazy-loaded at runtime (script
  // element is only injected when the user sees their first diagram), but
  // users who never want diagrams can set `sidecar.enableMermaid = false`
  // to skip even the URI injection so chat.js renders ```mermaid as plain
  // code instead.
  const cfg = getConfig();
  const mermaidEnabled = cfg.enableMermaid;
  const mermaidUri = mermaidEnabled
    ? webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'mermaid.min.js'))
    : null;
  const activeProfile = detectActiveProfile(cfg.baseUrl);
  const backendProfilesJson = JSON.stringify(
    BUILT_IN_BACKEND_PROFILES.map((p) => ({ id: p.id, name: p.name, description: p.description })),
  );
  const activeProfileId = activeProfile?.id ?? null;
  const nonce = crypto.randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- CSP: 'unsafe-eval' required by mermaid.js (uses Function() for diagram rendering).
       connect-src limited to Ollama/Kickstand default ports only. -->
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-eval'; img-src ${webview.cspSource} data: blob:; connect-src http://localhost:11434 http://localhost:11435 http://127.0.0.1:11434 http://127.0.0.1:11435;">
  <link rel="stylesheet" href="${stylesUri}">
</head>
<body>
  <div id="header-wrapper">
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
      <!--
        v0.62.2 q.1 — per-option tooltips explain what each mode
        actually does so new users don't need to dig through settings
        docs. Previously the picker listed only 4 of 6 shipped modes
        (review and audit were missing entirely, making those agent
        tiers invisible to anyone who didn't edit settings.json).
      -->
      <select id="agent-mode-select" class="agent-mode-select" aria-label="Agent mode">
        <option value="cautious" title="Ask before every write / command. Safest; slowest.">
          cautious
        </option>
        <option value="autonomous" title="Run tools without asking. Fastest; trust the agent.">
          autonomous
        </option>
        <option value="manual" title="Model proposes; you approve each step explicitly.">
          manual
        </option>
        <option value="plan" title="Produce a step-by-step plan first, then execute after approval.">
          plan
        </option>
        <option value="review" title="Buffer writes into a pending-review TreeView; accept per-file before they hit disk.">
          review
        </option>
        <option value="audit" title="All-or-nothing buffered writes + delete support; atomic accept/reject.">
          audit
        </option>
      </select>
      <div id="chat-actions">
        <button id="new-chat-btn" data-tooltip="New Chat" aria-label="New Chat">+</button>
        <button id="history-btn" data-tooltip="Conversation History" aria-label="Conversation History">&#128172;</button>
        <button id="compact-btn" data-tooltip="Compact Context" aria-label="Compact Context">&#9986;</button>
        <button id="settings-btn" data-tooltip="Settings" aria-label="Settings" aria-haspopup="true" aria-expanded="false">&#9776;</button>
      </div>
    </div>
    <div id="settings-menu" class="hidden" role="menu" aria-label="SideCar settings menu">
      <div class="settings-menu-section">
        <div class="settings-menu-label">Backend</div>
        <div id="backend-profile-list"></div>
      </div>
      <div class="settings-menu-section">
        <button class="settings-menu-item" data-action="exportChat" role="menuitem">Export chat as Markdown</button>
        <button class="settings-menu-item" data-action="openSettings" role="menuitem">Open SideCar settings...</button>
      </div>
    </div>
    <div id="activity-bar" class="hidden"></div>
    <div id="model-panel" class="hidden" role="dialog" aria-label="Model picker">
    <div id="model-panel-header">
      <span>Select Model</span>
      <button id="close-panel">&times;</button>
    </div>
    <div id="model-search-row">
      <input id="model-search-input" type="text" placeholder="Search models..." />
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
  </div>
  <div id="bg-agents-panel" class="hidden">
    <div id="bg-agents-header">
      <span>Background Agents</span>
      <span id="bg-agents-count"></span>
    </div>
    <div id="bg-agents-list"></div>
  </div>
  <div id="messages" role="log" aria-live="polite"></div>
  <button id="scroll-to-bottom" class="hidden" data-tooltip="Scroll to bottom" aria-label="Scroll to bottom">&#8595;</button>
  <div id="agent-progress" class="hidden">
    <span id="progress-step"></span>
    <span id="progress-time"></span>
    <span id="progress-tokens"></span>
  </div>
  <div id="stream-stats" class="hidden"></div>
  <div id="install-progress" class="hidden">
    <span id="install-text">Installing...</span>
    <div id="install-bar-wrap"><div id="install-bar" class="indeterminate"></div></div>
    <button id="cancel-install">Cancel</button>
  </div>
  <div id="file-attachment" class="hidden">
    <span id="file-attachment-name"></span>
    <button id="remove-attachment">&times;</button>
  </div>
  <div id="image-preview" class="hidden"></div>
  <div id="slash-autocomplete" class="hidden" role="listbox" aria-label="Slash commands"></div>
  <div id="resume-strip" class="hidden" role="region" aria-label="Resume available"></div>
  <div id="steer-queue-strip" class="hidden" role="region" aria-label="Queued steers"></div>
  <div id="input-area">
    <button id="attach-btn" data-tooltip="Attach file" aria-label="Attach file">&#128206;</button>
    <textarea id="input" rows="1" placeholder="Ask SideCar..."></textarea>
    <button id="send">Send</button>
  </div>

  <script nonce="${nonce}">window.__mermaidSrc = ${mermaidUri ? `"${mermaidUri}"` : 'null'}; window.__mermaidEnabled = ${mermaidEnabled}; window.__nonce = "${nonce}"; window.__backendProfiles = ${backendProfilesJson}; window.__activeBackendProfileId = ${activeProfileId ? `"${activeProfileId}"` : 'null'};</script>
  <!-- Load helper modules before chat.js so window.SideCar.* is populated. -->
  <script nonce="${nonce}" src="${githubCardsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
