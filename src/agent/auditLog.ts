import type { SidecarDir } from '../config/sidecarDir.js';

/**
 * A single audit log entry recording one tool execution.
 */
export interface AuditEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Agent session ID */
  sessionId: string;
  /** Tool name */
  tool: string;
  /** Unique tool call ID from the model */
  toolCallId: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** Truncated result (first 500 chars) */
  result: string;
  /** Whether the tool call errored */
  isError: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Agent loop iteration number */
  iteration: number;
  /** Approval mode active at time of call */
  approvalMode: string;
  /** Model that made the decision */
  model: string;
}

export interface AuditFilter {
  /** Filter by tool name */
  tool?: string;
  /** Filter by session ID */
  sessionId?: string;
  /** Only errors */
  errorsOnly?: boolean;
  /** Maximum entries to return (default 50) */
  limit?: number;
  /** ISO date string — only entries after this time */
  since?: string;
}

const AUDIT_FILE = 'logs/audit.jsonl';
const MAX_RESULT_LENGTH = 500;

/**
 * Append-only structured audit log for agent tool executions.
 * Stored as JSONL in `.sidecar/logs/audit.jsonl` (gitignored).
 */
export class AuditLog {
  private pendingEntry: Partial<AuditEntry> | null = null;

  constructor(
    private sidecarDir: SidecarDir,
    private sessionId: string,
    private model: string,
    private approvalMode: string,
  ) {}

  /** Update session context (call on new chat or config change). */
  setContext(sessionId: string, model: string, approvalMode: string): void {
    this.sessionId = sessionId;
    this.model = model;
    this.approvalMode = approvalMode;
  }

  /** Record the start of a tool call. */
  recordToolCall(tool: string, input: Record<string, unknown>, toolCallId: string, iteration: number): void {
    this.pendingEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      tool,
      toolCallId,
      input,
      iteration,
      approvalMode: this.approvalMode,
      model: this.model,
    };
  }

  /** Record the result of a tool call and flush to disk. */
  async recordToolResult(
    tool: string,
    toolCallId: string,
    result: string,
    isError: boolean,
    durationMs: number,
  ): Promise<void> {
    // Match against pending entry, or create a standalone entry
    let entry: AuditEntry;
    if (this.pendingEntry && this.pendingEntry.toolCallId === toolCallId) {
      entry = {
        ...this.pendingEntry,
        result: result.slice(0, MAX_RESULT_LENGTH),
        isError,
        durationMs,
      } as AuditEntry;
      this.pendingEntry = null;
    } else {
      entry = {
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        tool,
        toolCallId,
        input: {},
        result: result.slice(0, MAX_RESULT_LENGTH),
        isError,
        durationMs,
        iteration: 0,
        approvalMode: this.approvalMode,
        model: this.model,
      };
    }

    try {
      await this.sidecarDir.appendJsonl(AUDIT_FILE, entry);
    } catch (err) {
      console.warn('Failed to write audit log entry:', err);
    }
  }

  /** Read and optionally filter audit log entries. */
  async query(filter?: AuditFilter): Promise<AuditEntry[]> {
    const raw = await this.sidecarDir.readText(AUDIT_FILE);
    if (!raw) return [];

    const limit = filter?.limit ?? 50;
    const sinceMs = filter?.since ? new Date(filter.since).getTime() : 0;

    const entries: AuditEntry[] = [];
    const lines = raw.split('\n');
    // Parse in reverse for most-recent-first, then reverse at the end
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (filter?.tool && entry.tool !== filter.tool) continue;
        if (filter?.sessionId && entry.sessionId !== filter.sessionId) continue;
        if (filter?.errorsOnly && !entry.isError) continue;
        if (sinceMs && new Date(entry.timestamp).getTime() < sinceMs) continue;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries.reverse();
  }

  /** Get a single entry by tool call ID. */
  async getByToolCallId(toolCallId: string): Promise<AuditEntry | null> {
    const raw = await this.sidecarDir.readText(AUDIT_FILE);
    if (!raw) return null;

    // Search from end since recent entries are most likely
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.toolCallId === toolCallId) return entry;
      } catch {
        // Skip malformed lines
      }
    }
    return null;
  }

  /** Total number of entries in the log. */
  async count(): Promise<number> {
    const raw = await this.sidecarDir.readText(AUDIT_FILE);
    if (!raw) return 0;
    return raw.split('\n').filter((l) => l.trim()).length;
  }

  /** Clear the audit log. */
  async clear(): Promise<void> {
    try {
      await this.sidecarDir.writeText(AUDIT_FILE, '');
    } catch {
      // Ignore
    }
  }
}
