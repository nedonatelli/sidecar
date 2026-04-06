import type { ExtensionContext } from 'vscode';
import { type ChatMessage, getContentText } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { ChangeLog } from '../agent/changelog.js';
import { SessionManager } from '../agent/sessions.js';
import { MetricsCollector } from '../agent/metrics.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';
import type { ExtensionMessage } from './chatWebview.js';
import { getConfig } from '../config/settings.js';

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

  clearChat(): void {
    this.messages = [];
    this.pendingPlan = null;
    this.pendingPlanMessages = [];
    this.changelog.clear();
    this.saveHistory();
    this.postMessage({ command: 'chatCleared' });
  }
}
