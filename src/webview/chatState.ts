import { workspace, Uri, RelativePattern, type ExtensionContext, type Disposable } from 'vscode';
import { type ChatMessage, getContentText, getContentLength, serializeContent } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { buildRouterFromConfig } from '../ollama/modelRouter.js';
import { ChangeLog } from '../agent/changelog.js';
import { PendingEditStore } from '../agent/pendingEdits.js';
import { SteerQueue, type QueuedSteer } from '../agent/steerQueue.js';
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
import { PinnedMemoryStore } from '../agent/memory/pinnedMemory.js';
import { AuditLog } from '../agent/auditLog.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  /**
   * Conversation history. Mutation invariant: mutations are safe from
   * the chat handlers on the main event loop as long as no agent run is
   * in flight. When `abortController` is non-null, any splice / pop
   * that removes a pre-existing message will corrupt the merge
   * bookkeeping in `postLoopProcessing` — callers must either abort
   * the run first or append-only. The agent loop itself does NOT write
   * to this array directly; it operates on a shallow copy and its
   * return value is merged back in via `postLoopProcessing`.
   */
  messages: ChatMessage[] = [];
  pendingPlan: string | null = null;
  pendingPlanMessages: ChatMessage[] = [];
  /**
   * Captured assistant text from a stream that died mid-turn. `null` if
   * no partial is available or the partial has been consumed. Populated
   * by the `onStreamFailure` callback in the agent loop and consumed by
   * the `/resume` slash command, which re-issues the failed turn with
   * the partial as a "continue from here" hint. Cleared on any
   * successful turn so we never replay a stale partial.
   */
  pendingPartialAssistant: string | null = null;
  abortController: AbortController | null = null;
  installAbortController: AbortController | null = null;
  /**
   * Active steer queue for the in-flight agent run (v0.65 chunk 3).
   * Created by `handleUserMessage` when a run starts, disposed in
   * the finally block. When null, the webview strip hides itself.
   * Only non-null during an active run so webview steer messages
   * arriving outside that window are ignored.
   */
  currentSteerQueue: SteerQueue | null = null;
  /** Disposer for the steerQueue onChange subscription. */
  currentSteerDisposer: (() => void) | null = null;
  /**
   * Serialized steer queue stashed when a run fails mid-stream
   * (v0.65 chunk 3.4 persistence). Lets `/resume` (or the next
   * user-initiated turn) repopulate the fresh queue with the
   * steers that were still pending when the stream died, so a
   * network drop or backend crash doesn't silently swallow typed
   * instructions. Cleared on successful consumption and on
   * clearChat so a stale snapshot can't leak into an unrelated
   * new conversation.
   */
  pendingSteerSnapshot: QueuedSteer[] | null = null;
  private pendingConfirms = new Map<string, (choice: string | undefined) => void>();
  private confirmCounter = 0;
  changelog = new ChangeLog();
  pendingEdits = new PendingEditStore();
  sessionManager: SessionManager;
  metricsCollector: MetricsCollector;
  workspaceIndex: WorkspaceIndex | null = null;
  sidecarDir: SidecarDir | null = null;
  skillLoader: SkillLoader | null = null;
  contentProvider: ProposedContentProvider | null = null;
  inlineEditProvider: InlineEditProvider | null = null;
  documentationIndexer: DocumentationIndexer | null = null;
  agentMemory: AgentMemory | null = null;
  pinnedMemoryStore: PinnedMemoryStore | null = null;
  auditLog: AuditLog | null = null;

  /** ID of the current auto-saved session, null if conversation is empty/unsaved */
  currentSessionId: string | null = null;

  /** Path to the current chat log tmp file */
  private chatLogPath: string | null = null;

  /**
   * SIDECAR.md content cache. `undefined` = not yet loaded; `null` =
   * checked but file absent or empty; `string` = cached content. The
   * cache used to live as a module-level global in chatHandlers.ts
   * and leaked watchers across webview toggles, which the cycle-2
   * architecture audit flagged as HIGH. Moved onto ChatState so it
   * shares the state's lifetime and gets torn down by `dispose()`.
   */
  private sidecarMdCache: string | null | undefined;
  private sidecarMdWatcher: Disposable | null = null;

  /** Tracks whether this state has been disposed, to reject late callers. */
  private disposed = false;

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
    this.client.setRouter(buildRouterFromConfig(config));
    this.sessionManager = new SessionManager(context.globalState);
    this.metricsCollector = new MetricsCollector(context.workspaceState);
  }

  /**
   * Rebuild the Role-Based Model Router from current settings and
   * attach it to the active client. Call this whenever a
   * `sidecar.modelRouting.*` setting changes so rule edits take effect
   * without requiring a window reload.
   */
  refreshModelRouter(): void {
    const config = getConfig();
    this.client.setRouter(buildRouterFromConfig(config));
  }

  postMessage(message: ExtensionMessage): void {
    this._postMessage(message);
  }

  /**
   * Get or create the tmp file path for the current chat log.
   * Each conversation gets its own file in the OS temp directory.
   * Format: sidecar-chat-{timestamp}.jsonl
   */
  private ensureChatLogPath(): string {
    if (!this.chatLogPath) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tmpDir = path.join(os.tmpdir(), 'sidecar-chatlogs');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      this.chatLogPath = path.join(tmpDir, `sidecar-chat-${timestamp}.jsonl`);
    }
    return this.chatLogPath;
  }

  /**
   * Append a message to the chat log tmp file.
   * Each line is a JSON object with role, content, and timestamp.
   */
  logMessage(role: string, content: string): void {
    try {
      const logPath = this.ensureChatLogPath();
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        role,
        content,
      });
      fs.appendFileSync(logPath, entry + '\n');
    } catch {
      // Chat logging is best-effort — never block the user
    }
  }

  /** Get the path to the current chat log file, or null if none started. */
  getChatLogPath(): string | null {
    return this.chatLogPath;
  }

  /** Reset the chat log path so a new conversation gets a fresh log file. */
  resetChatLog(): void {
    this.chatLogPath = null;
  }

  saveHistory(): void {
    const serializable = this.messages.map((m) => ({
      role: m.role,
      content: serializeContent(m.content),
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
   * Show a confirmation prompt and await the user's choice. Returns the
   * label of the button clicked, or undefined if dismissed.
   *
   * By default the prompt renders as an inline chat card so the user
   * sees the approval alongside the tool-call record. When `options.modal`
   * is set, a native blocking VS Code modal (`showWarningMessage` with
   * `modal: true`) is shown instead — used for destructive tools like
   * `run_command` and git mutations so the user can't miss the prompt
   * while focused elsewhere.
   */
  async requestConfirm(
    message: string,
    actions: string[],
    options?: { modal?: boolean; detail?: string },
  ): Promise<string | undefined> {
    if (options?.modal) {
      // Native modal path: strip markdown bold markers from the
      // message, forward actions as button titles. Returns undefined
      // when the user dismisses the modal via Esc or close.
      const { window } = await import('vscode');
      const cleanMessage = message.replace(/\*\*/g, '');
      const items = actions.map((title) => ({ title }));
      const picked = await window.showWarningMessage(cleanMessage, { modal: true, detail: options.detail }, ...items);
      return picked?.title;
    }

    // Default inline-chat path — unchanged, always used for non-destructive
    // approvals and every read-only tool.
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
    this.pendingPartialAssistant = null;
    this.pendingSteerSnapshot = null;
    this.pendingQuestion = null;
    this.changelog.clear();
    this.currentSessionId = null;
    this.chatGeneration++;
    this.resetChatLog();
    // Reset workspace file relevance so previously discussed files
    // don't dominate context in the new conversation.
    this.workspaceIndex?.resetRelevance();
    // Rotate agent memory session so new memories are tagged separately
    // and past-session memories are clearly labeled in context.
    this.agentMemory?.startSession();
    // Update audit log with new session ID
    if (this.auditLog && this.agentMemory) {
      this.auditLog.setContext(this.agentMemory.getSessionId(), this.client.getModel(), 'cautious');
    }
    this.saveHistory();
    this.postMessage({ command: 'chatCleared' });
  }

  /**
   * Load SIDECAR.md content (cached, with filesystem watcher for
   * cache invalidation). Checks `.sidecar/SIDECAR.md` first, falls
   * back to `SIDECAR.md` at the project root. Returns the trimmed
   * content, or null if neither file exists or both are empty.
   *
   * The cache and its watcher live on `ChatState` so they're torn
   * down by `dispose()` when the state is recreated — without this,
   * toggling the webview off and on leaked a file-system watcher
   * per cycle.
   */
  async loadSidecarMd(): Promise<string | null> {
    if (this.disposed) return null;
    if (this.sidecarMdCache !== undefined) return this.sidecarMdCache;

    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return null;

    // Check .sidecar/SIDECAR.md first, fall back to root SIDECAR.md
    const candidates = [Uri.joinPath(rootUri, '.sidecar', 'SIDECAR.md'), Uri.joinPath(rootUri, 'SIDECAR.md')];

    this.sidecarMdCache = null;
    for (const fileUri of candidates) {
      try {
        const bytes = await workspace.fs.readFile(fileUri);
        const content = Buffer.from(bytes).toString('utf-8').trim();
        if (content) {
          this.sidecarMdCache = content;
          break;
        }
      } catch {
        // Not found — try next
      }
    }

    // Watch for changes at both locations and invalidate cache. Wire
    // the watcher once per state instance; it's disposed by `dispose()`.
    if (!this.sidecarMdWatcher) {
      const invalidate = () => {
        this.sidecarMdCache = undefined;
      };
      const watcher1 = workspace.createFileSystemWatcher(new RelativePattern(rootUri, 'SIDECAR.md'));
      const watcher2 = workspace.createFileSystemWatcher(new RelativePattern(rootUri, '.sidecar/SIDECAR.md'));
      for (const w of [watcher1, watcher2]) {
        w.onDidChange(invalidate);
        w.onDidCreate(invalidate);
        w.onDidDelete(invalidate);
      }
      this.sidecarMdWatcher = {
        dispose: () => {
          watcher1.dispose();
          watcher2.dispose();
        },
      };
    }

    return this.sidecarMdCache;
  }

  /**
   * Tear down every resource owned by this ChatState. Safe to call
   * multiple times. Idempotent.
   *
   * Disposes:
   *   - The in-flight agent-loop abort controller (so outstanding
   *     promises reject cleanly)
   *   - Every pending confirmation prompt (resolves them as 'Reject'
   *     so awaiting callers unwind)
   *   - The PendingEditStore (the field-initialized one we own)
   *   - The SIDECAR.md filesystem watcher (previously a module-level
   *     leak in chatHandlers.ts)
   *
   * What we deliberately do NOT dispose: workspaceIndex, sidecarDir,
   * skillLoader, contentProvider, inlineEditProvider, documentationIndexer,
   * agentMemory, auditLog, mcpManager, terminalManager, agentLogger.
   * Those are all owned by the extension host and passed in via the
   * constructor or setters — their lifetime is longer than any single
   * ChatState instance.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort();
    this.abortController = null;
    this.pendingEdits.dispose();
    this.sidecarMdWatcher?.dispose();
    this.sidecarMdWatcher = null;
    this.sidecarMdCache = undefined;
  }
}
