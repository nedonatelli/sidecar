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

  // Check each message's shape, not just that `messages` is an array (#227,
  // from #121). The import assigns these straight into the chat state, so a
  // hand-edited bundle with a bad role or a block missing its text broke the
  // session later (e.g. `serializeContent` reading `.length` of a missing
  // tool_result `content`) instead of being rejected here.
  const badIndex = obj.messages.findIndex((m) => !isChatMessage(m));
  if (badIndex !== -1) {
    return { ok: false, error: `Message ${badIndex + 1} is not a valid chat message.` };
  }

  return { ok: true, bundle: parsed as HandoffBundle };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isContentBlock(v: unknown): boolean {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case 'text':
      return typeof v.text === 'string';
    case 'thinking':
      return typeof v.thinking === 'string';
    case 'tool_use':
      return typeof v.id === 'string' && typeof v.name === 'string' && isRecord(v.input);
    case 'tool_result':
      return typeof v.tool_use_id === 'string' && typeof v.content === 'string';
    case 'image':
      return isRecord(v.source) && typeof v.source.data === 'string';
    default:
      return false;
  }
}

function isChatMessage(v: unknown): v is ChatMessage {
  if (!isRecord(v)) return false;
  if (v.role !== 'user' && v.role !== 'assistant') return false;
  return typeof v.content === 'string' || (Array.isArray(v.content) && v.content.every(isContentBlock));
}

export function formatExportedAt(ts: number): string {
  return new Date(ts).toLocaleString();
}
