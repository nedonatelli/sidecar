import type { ExtensionContext } from 'vscode';
import { type ChatMessage, getContentText, getContentLength } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { ChangeLog } from '../agent/changelog.js';
import { SessionManager } from '../agent/sessions.js';
import { MetricsCollector } from '../agent/metrics.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { SkillLoader } from '../agent/skillLoader.js';
import type { ProposedContentProvider } from '../edits/proposedContentProvider.js';
import type { InlineEditProvider } from '../edits/inlineEditProvider.js';
import type { ExtensionMessage } from './chatWebview.js';
import { getConfig } from '../config/settings.js';
import { DocumentationIndexer } from '../config/documentationIndexer.js';
import { AgentMemory } from '../agent/agentMemory.js';

/** Maximum number of messages to keep in memory. */
const MAX_HISTORY_MESSAGES = 200;
/** Maximum total character size of in-memory history. */
const MAX_HISTORY_CHARS = 2_000_000; // ~2MB

/**
 * Shared mutable state for the chat view.
 * Extracted from ChatViewProvider to enable handler functions
 * to operate on state without coupling to the provider class.
 */
export class ChatState {
  client: SideCarClient;
  messages: ChatMessage[] = [];
  pendingPlan: string | null = null;
  pendingPlanMessages: ChatMessage[] = [];
  abortController: AbortController | null = null;
  installAbortController: AbortController | null = null;
  private pendingConfirms = new Map<string, (choice: string | undefined) => void>();
  private confirmCounter = 0;
  changelog = new ChangeLog();
  sessionManager: SessionManager;
  metricsCollector: MetricsCollector;
  workspaceIndex: WorkspaceIndex | null = null;
  sidecarDir: SidecarDir | null = null;
  skillLoader: SkillLoader | null = null;
  contentProvider: ProposedContentProvider | null = null;
  inlineEditProvider: InlineEditProvider | null = null;
  documentationIndexer: DocumentationIndexer | null = null;
  agentMemory: AgentMemory | null = null;

  /** ID of the current auto-saved session, null if conversation is empty/unsaved */
  currentSessionId: string | null = null;

  /**
   * Tracks when the assistant's last message ended with a question.
   * If set, the next user message is likely a direct response to this question,
   * and context will be injected to help the LLM understand the relationship.
   */
  pendingQuestion: string | null = null;

  constructor(
    readonly context: ExtensionContext,
    readonly terminalManager: TerminalManager,
    readonly agentLogger: AgentLogger,
    readonly mcpManager: MCPManager,
    private _postMessage: (msg: ExtensionMessage) => void,
  ) {
    const config = getConfig();
    this.client = new SideCarClient(config.model, config.baseUrl, config.apiKey);
    this.sessionManager = new SessionManager(context.globalState);
    this.metricsCollector = new MetricsCollector(context.workspaceState);
  }

  postMessage(message: ExtensionMessage): void {
    this._postMessage(message);
  }

  saveHistory(): void {
    const serializable = this.messages.map((m) => ({
      role: m.role,
      content: getContentText(m.content),
    }));
    this.context.workspaceState.update('sidecar.chatHistory', serializable);
  }

  loadHistory(): ChatMessage[] {
    const messages = this.context.workspaceState.get<ChatMessage[]>('sidecar.chatHistory', []);
    // Filter out stale placeholder entries from pre-v0.11.0 history
    return messages.filter((m) => m.content !== '[message with images]');
  }

  abort(): void {
    this.abortController?.abort();
    // Resolve any pending confirmation prompts so their promises don't dangle
    if (this.pendingConfirms.size > 0) {
      this.resolveAllConfirms('Reject');
    }
  }

  cancelInstall(): void {
    this.installAbortController?.abort();
  }

  /**
   * Show an inline confirmation card in the chat and await the user's choice.
   * Returns the label of the button clicked, or undefined if dismissed.
   */
  requestConfirm(message: string, actions: string[]): Promise<string | undefined> {
    const id = `confirm_${++this.confirmCounter}`;
    return new Promise((resolve) => {
      this.pendingConfirms.set(id, resolve);
      this.postMessage({ command: 'confirm', content: message, confirmId: id, confirmActions: actions });
    });
  }

  resolveConfirm(id: string, choice: string | undefined): void {
    const resolve = this.pendingConfirms.get(id);
    if (resolve) {
      this.pendingConfirms.delete(id);
      resolve(choice);
    }
  }

  /**
   * Auto-resolve all pending confirmation prompts with the given choice.
   * Used when switching to autonomous mode so the agent isn't left blocked.
   */
  resolveAllConfirms(choice: string): void {
    for (const [id, resolve] of this.pendingConfirms) {
      resolve(choice);
      this.postMessage({ command: 'dismissConfirm', confirmId: id });
    }
    this.pendingConfirms.clear();
  }

  /**
   * Show a clarification card with selectable options and optional custom text input.
   * Returns the user's selected option or custom text, or undefined if dismissed.
   */
  requestClarification(question: string, options: string[], allowCustom: boolean = true): Promise<string | undefined> {
    const id = `clarify_${++this.confirmCounter}`;
    return new Promise((resolve) => {
      this.pendingConfirms.set(id, resolve);
      this.postMessage({
        command: 'clarify',
        content: question,
        clarifyId: id,
        clarifyOptions: options,
        clarifyAllowCustom: allowCustom,
      });
    });
  }

  resolveClarification(id: string, choice: string | undefined): void {
    const resolve = this.pendingConfirms.get(id);
    if (resolve) {
      this.pendingConfirms.delete(id);
      resolve(choice);
    }
  }

  /**
   * Auto-save the current conversation to the session store.
   * Creates a new session on first save, updates in place after that.
   * Skips if the conversation is empty.
   */
  autoSave(): void {
    if (this.messages.length === 0) return;

    if (this.currentSessionId && this.sessionManager.update(this.currentSessionId, this.messages)) {
      return;
    }

    // Generate a name from the first user message
    const firstUserMsg = this.messages.find((m) => m.role === 'user');
    const preview = firstUserMsg
      ? (typeof firstUserMsg.content === 'string' ? firstUserMsg.content : getContentText(firstUserMsg.content))
          .slice(0, 50)
          .replace(/\n/g, ' ')
      : 'Conversation';
    const name = preview.length >= 50 ? preview + '...' : preview;

    const session = this.sessionManager.save(name, this.messages);
    this.currentSessionId = session.id;
  }

  /**
   * Trim in-memory history when it exceeds size bounds.
   * Drops oldest message pairs (preserving user/assistant pairing)
   * until both message count and character size are within limits.
   */
  trimHistory(): void {
    // Trim by message count
    while (this.messages.length > MAX_HISTORY_MESSAGES) {
      this.messages.shift();
    }

    // Trim by total character size
    let totalChars = this.messages.reduce((sum, m) => sum + getContentLength(m.content), 0);
    while (totalChars > MAX_HISTORY_CHARS && this.messages.length > 2) {
      const removed = this.messages.shift()!;
      totalChars -= getContentLength(removed.content);
    }
  }

  /** Monotonically increasing generation counter, bumped on each clearChat. */
  chatGeneration = 0;

  clearChat(): void {
    this.autoSave();
    // Abort any in-flight agent loop so its post-loop code doesn't
    // overwrite the cleared messages with old conversation history.
    this.abort();
    this.abortController = null;
    this.messages = [];
    this.pendingPlan = null;
    this.pendingPlanMessages = [];
    this.pendingQuestion = null;
    this.changelog.clear();
    this.currentSessionId = null;
    this.chatGeneration++;
    // Reset workspace file relevance so previously discussed files
    // don't dominate context in the new conversation.
    this.workspaceIndex?.resetRelevance();
    // Rotate agent memory session so new memories are tagged separately
    // and past-session memories are clearly labeled in context.
    this.agentMemory?.startSession();
    this.saveHistory();
    this.postMessage({ command: 'chatCleared' });
  }
}
