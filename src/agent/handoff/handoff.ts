import type { ChatMessage } from '../../ollama/types.js';
import { serializeContent, getContentText } from '../../ollama/types.js';

export interface HandoffBundle {
  version: 1;
  exportedAt: number;
  /** First user message, truncated to 120 chars — gives the recipient quick context. */
  task: string;
  /** Optional note from the exporter (what's done, what's left, gotchas). */
  note: string;
  messages: ChatMessage[];
}

const MAX_TASK_CHARS = 120;

function extractTask(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '(no task)';
  const text = getContentText(first.content);
  return text.length > MAX_TASK_CHARS ? text.slice(0, MAX_TASK_CHARS) + '…' : text;
}

export function buildBundle(messages: ChatMessage[], note: string): HandoffBundle {
  const serialized = messages.map((m) => ({
    role: m.role,
    content: serializeContent(m.content),
  })) as ChatMessage[];

  return {
    version: 1,
    exportedAt: Date.now(),
    task: extractTask(messages),
    note,
    messages: serialized,
  };
}

export type ParseResult = { ok: true; bundle: HandoffBundle } | { ok: false; error: string };

export function parseBundle(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'File is not valid JSON.' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'Unexpected JSON structure.' };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.version !== 1) {
    return { ok: false, error: `Unsupported handoff version: ${String(obj.version)}` };
  }

  if (!Array.isArray(obj.messages)) {
    return { ok: false, error: 'Missing or invalid "messages" field.' };
  }

  return { ok: true, bundle: parsed as HandoffBundle };
}

export function formatExportedAt(ts: number): string {
  return new Date(ts).toLocaleString();
}
