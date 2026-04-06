import type { ExtensionContext } from 'vscode';
import type { ChatMessage } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { ChangeLog } from '../agent/changelog.js';
import { SessionManager } from '../agent/sessions.js';
import { MetricsCollector } from '../agent/metrics.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { ExtensionMessage } from './chatWebview.js';
import { getModel, getBaseUrl, getApiKey } from '../config/settings.js';

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
  changelog = new ChangeLog();
  sessionManager: SessionManager;
  metricsCollector: MetricsCollector;

  constructor(
    readonly context: ExtensionContext,
    readonly terminalManager: TerminalManager,
    readonly agentLogger: AgentLogger,
    readonly mcpManager: MCPManager,
    private _postMessage: (msg: ExtensionMessage) => void,
  ) {
    this.client = new SideCarClient(getModel(), getBaseUrl(), getApiKey());
    this.sessionManager = new SessionManager(context.globalState);
    this.metricsCollector = new MetricsCollector(context.workspaceState);
  }

  postMessage(message: ExtensionMessage): void {
    this._postMessage(message);
  }

  saveHistory(): void {
    const serializable = this.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '[message with images]',
    }));
    this.context.workspaceState.update('sidecar.chatHistory', serializable);
  }

  loadHistory(): ChatMessage[] {
    return this.context.workspaceState.get<ChatMessage[]>('sidecar.chatHistory', []);
  }

  abort(): void {
    this.abortController?.abort();
  }

  cancelInstall(): void {
    this.installAbortController?.abort();
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
