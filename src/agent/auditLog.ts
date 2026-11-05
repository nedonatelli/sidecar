import type { SidecarDir } from '../config/sidecarDir.js';
import { logger } from '../system/logger.js';
import { redactSecrets } from './securityScanner.js';

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

export interface TextTurnEntry {
  timestamp: string;
  sessionId: string;
  iteration: number;
  model: string;
  approvalMode: string;
  text: string;
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
const TRACE_FILE = 'logs/trace.jsonl';
const MAX_RESULT_LENGTH = 2000;

/** Every string in `value` with known secret shapes replaced, as the MCP and API logs do. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

/**
 * Append-only structured audit log for agent tool executions.
 * Stored as JSONL in `.sidecar/logs/audit.jsonl` (gitignored).
 */
export class AuditLog {
  /**
   * Calls started and not yet finished, by toolCallId (a queue per id: Ollama
   * reuses ids such as ollama_tc_0). One slot used to hold them all, so in a
   * turn with several calls every result but the last was logged with
   * `input: {}` (#116).
   */
  private pending = new Map<string, Partial<AuditEntry>[]>();

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
    const started: Partial<AuditEntry> = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      tool,
      toolCallId,
      input,
      iteration,
      approvalMode: this.approvalMode,
      model: this.model,
    };
    const queue = this.pending.get(toolCallId) ?? [];
    queue.push(started);
    this.pending.set(toolCallId, queue);
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
    const queue = this.pending.get(toolCallId);
    const started = queue?.shift();
    if (queue && queue.length === 0) this.pending.delete(toolCallId);
    if (started) {
      entry = {
        ...started,
        result: result.slice(0, MAX_RESULT_LENGTH),
        isError,
        durationMs,
      } as AuditEntry;
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

    // A command, a file written or a tool's output can hold a credential, and
    // the log keeps it on disk with no end date.
    entry.input = redact(entry.input) as Record<string, unknown>;
    entry.result = redactSecrets(entry.result);

    try {
      await this.sidecarDir.appendJsonl(AUDIT_FILE, entry);
    } catch (err) {
      logger.warn('Failed to write audit log entry:', err);
    }
  }

  /** Record a completed assistant text turn to trace.jsonl. */
  async recordTextTurn(text: string, iteration: number): Promise<void> {
    const entry: TextTurnEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      iteration,
      model: this.model,
      approvalMode: this.approvalMode,
      text: redactSecrets(text),
    };
    try {
      await this.sidecarDir.appendJsonl(TRACE_FILE, entry);
    } catch (err) {
      logger.warn('Failed to write trace log entry:', err);
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
