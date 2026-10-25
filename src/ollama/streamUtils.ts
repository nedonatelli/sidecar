import type { StreamEvent, ToolDefinition, ToolUseContentBlock } from './types.js';
import { findBalancedEnd } from '../agent/delimiters.js';

// ---------------------------------------------------------------------------
// Shared tool definition conversion
// ---------------------------------------------------------------------------

export interface FunctionToolFormat {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Convert SideCar ToolDefinition[] to the function-calling format used by Ollama and OpenAI. */
export function toFunctionTools(tools: ToolDefinition[]): FunctionToolFormat[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object' as const,
        properties: t.input_schema.properties,
        required: t.input_schema.required,
      },
    },
  }));
}

// ---------------------------------------------------------------------------
// Shared <think> tag parser
// ---------------------------------------------------------------------------

export interface ThinkTagState {
  insideThinkTag: boolean;
}

/**
 * Parse a content chunk that may contain `<think>` / `</think>` tags,
 * yielding StreamEvents for text and thinking segments.
 *
 * The `state` object is mutated to track whether we're inside a think tag
 * across multiple chunks.
 */
export function* parseThinkTags(content: string, state: ThinkTagState): Generator<StreamEvent> {
  // Use index tracking instead of repeated string slicing to reduce
  // intermediate string allocations and GC pressure.
  let pos = 0;
  const len = content.length;

  while (pos < len) {
    if (!state.insideThinkTag) {
      const openIdx = content.indexOf('<think>', pos);
      if (openIdx === -1) {
        yield { type: 'text', text: content.substring(pos) };
        break;
      }
      if (openIdx > pos) {
        yield { type: 'text', text: content.substring(pos, openIdx) };
      }
      state.insideThinkTag = true;
      pos = openIdx + 7; // skip '<think>'
    } else {
      const closeIdx = content.indexOf('</think>', pos);
      if (closeIdx === -1) {
        yield { type: 'thinking', thinking: content.substring(pos) };
        break;
      }
      if (closeIdx > pos) {
        yield { type: 'thinking', thinking: content.substring(pos, closeIdx) };
      }
      state.insideThinkTag = false;
      pos = closeIdx + 8; // skip '</think>'
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming text-based tool call parser
// ---------------------------------------------------------------------------

/**
 * State for parseTextToolCallsStream — persists across chunks so XML-style
 * tool-call blocks that span chunk boundaries are handled correctly.
 */
export interface TextToolCallState {
  buffer: string;
  inBody: boolean;
  bodyKind: 'fn' | 'tc' | null;
  bodyToolName: string | null;
  toolNames: Set<string>;
  idCounter: { n: number };
}

export function createTextToolCallState(tools: ToolDefinition[] | undefined): TextToolCallState {
  return {
    buffer: '',
    inBody: false,
    bodyKind: null,
    bodyToolName: null,
    toolNames: new Set((tools ?? []).map((t) => t.name)),
    idCounter: { n: 0 },
  };
}

/**
 * Return true if `tail` (which must start with '<') could still become the
 * start of a recognized marker once more characters arrive. Used to decide
 * how much of the buffer is safe to flush across a chunk boundary.
 */
function mightStartMarker(tail: string): boolean {
  // '<tool_call>' prefix (strict — full form is handled earlier as indexOf)
  if ('<tool_call>'.startsWith(tail)) return true;
  // '<function=' prefix without the '=' sign yet
  if ('<function='.startsWith(tail)) return true;
  // '<function=' followed by partial name and no closing '>'
  if (/^<function=\w*$/.test(tail)) return true;
  return false;
}

/**
 * Incrementally parse a text chunk, intercepting text-based tool-call syntax
 * emitted by models that don't use structured tool_calls (e.g. qwen3-coder,
 * Hermes). Recognized formats:
 *   - <function=name><parameter=key>value</parameter></function>
 *   - <tool_call>{"name":"...","arguments":{...}}</tool_call>
 *
 * Non-tool-call text is yielded as `text` events. Recognized tool-call blocks
 * are yielded as `tool_use` events and suppressed from the text stream so the
 * raw XML never reaches the UI. Trailing bytes that *might* be the start of a
 * marker are held in `state.buffer` until the next chunk arrives; call
 * flushTextToolCallsStream() when the stream ends to drain remaining text.
 */
export function* parseTextToolCallsStream(text: string, state: TextToolCallState): Generator<StreamEvent> {
  state.buffer += text;

  while (true) {
    if (state.inBody) {
      const end = state.bodyKind === 'fn' ? functionBodyEnd(state.buffer) : toolCallBodyEnd(state.buffer);
      // Keep collecting the body — don't emit anything.
      if (end === null) return;

      const body = state.buffer.substring(0, end.bodyEnd);
      const consumed = state.buffer.substring(0, end.resume);
      state.buffer = state.buffer.substring(end.resume);

      const toolUse = parseToolCallBody(state.bodyKind!, state.bodyToolName, body, state);
      if (toolUse) {
        yield { type: 'tool_use', toolUse };
      } else {
        // #246: an unparseable body naming no known tool is the model's text, not
        // a call. It used to be dropped, so a turn could end with nothing at all.
        yield { type: 'text', text: `<tool_call>${consumed}` };
      }

      state.inBody = false;
      state.bodyKind = null;
      state.bodyToolName = null;
      continue;
    }

    // Not in a tool-call body — look for the earliest start marker.
    const fnMatch = /<function=(\w+)>/.exec(state.buffer);
    const tcIdx = state.buffer.indexOf('<tool_call>');

    // Pick whichever appears first in the buffer.
    let useFn = false;
    let useTc = false;
    if (fnMatch && (tcIdx === -1 || fnMatch.index < tcIdx)) {
      useFn = true;
    } else if (tcIdx !== -1) {
      useTc = true;
    }

    if (useFn && fnMatch) {
      if (!state.toolNames.has(fnMatch[1])) {
        // Unknown name — not a real tool call. Emit through this marker as text
        // and keep scanning for a valid one after it.
        const emitEnd = fnMatch.index + fnMatch[0].length;
        yield { type: 'text', text: state.buffer.substring(0, emitEnd) };
        state.buffer = state.buffer.substring(emitEnd);
        continue;
      }
      if (fnMatch.index > 0) {
        yield { type: 'text', text: state.buffer.substring(0, fnMatch.index) };
      }
      state.buffer = state.buffer.substring(fnMatch.index + fnMatch[0].length);
      state.inBody = true;
      state.bodyKind = 'fn';
      state.bodyToolName = fnMatch[1];
      continue;
    }

    if (useTc) {
      if (tcIdx > 0) {
        yield { type: 'text', text: state.buffer.substring(0, tcIdx) };
      }
      state.buffer = state.buffer.substring(tcIdx + '<tool_call>'.length);
      state.inBody = true;
      state.bodyKind = 'tc';
      state.bodyToolName = null;
      continue;
    }

    // No full marker anywhere in the buffer. Scan for the leftmost `<`
    // whose tail could still become a marker; everything before it is safe
    // to emit, and the rest is held until more text arrives.
    if (state.buffer.length === 0) return;

    let holdFrom = -1;
    for (let i = 0; i < state.buffer.length; i++) {
      if (state.buffer[i] !== '<') continue;
      if (mightStartMarker(state.buffer.substring(i))) {
        holdFrom = i;
        break;
      }
    }

    if (holdFrom === -1) {
      yield { type: 'text', text: state.buffer };
      state.buffer = '';
    } else if (holdFrom > 0) {
      yield { type: 'text', text: state.buffer.substring(0, holdFrom) };
      state.buffer = state.buffer.substring(holdFrom);
    }
    return;
  }
}

/** Where an open body ends: the body is `buffer[0, bodyEnd)`, and scanning resumes at `resume`. */
interface BodyEnd {
  bodyEnd: number;
  resume: number;
}

/** A `<function=…>` body ends at `</function>`; null while it has not arrived. */
function functionBodyEnd(buffer: string): BodyEnd | null {
  const i = buffer.indexOf('</function>');
  return i === -1 ? null : { bodyEnd: i, resume: i + '</function>'.length };
}

/**
 * Where a `<tool_call>` body ends, or null to wait for more text (#246).
 *
 * A JSON body ends where its object closes, found by a scan that skips JSON
 * strings: `indexOf('</tool_call>')` stopped inside `"s='</tool_call>'"` and
 * dropped the call. What follows the object then decides how much to consume:
 *   - `</tool_call>`, the normal close;
 *   - a new `<tool_call>`: the close tag is missing, and the next call starts here;
 *   - another closing tag, such as `</think>`: the wrong close, consumed so no
 *     markup reaches the reply;
 *   - plain text: the close tag is missing, and the text is the model's reply.
 * A body that is not a JSON object keeps the old rule: up to `</tool_call>`, or
 * up to a new `<tool_call>` when that comes first.
 */
function toolCallBodyEnd(buffer: string): BodyEnd | null {
  const start = buffer.length - buffer.trimStart().length;
  if (start === buffer.length) return null;
  if (buffer[start] !== '{') {
    const close = buffer.indexOf('</tool_call>');
    const reopen = buffer.indexOf('<tool_call>');
    if (reopen !== -1 && (close === -1 || reopen < close)) return { bodyEnd: reopen, resume: reopen };
    return close === -1 ? null : { bodyEnd: close, resume: close + '</tool_call>'.length };
  }
  const objEnd = findBalancedEnd(buffer, start, { dialect: 'json' });
  if (objEnd === -1) return null;
  const bodyEnd = objEnd + 1;
  let j = bodyEnd;
  while (j < buffer.length && /\s/.test(buffer[j])) j++;
  const rest = buffer.substring(j);
  if (rest === '') return null;
  if (rest.startsWith('</tool_call>')) return { bodyEnd, resume: j + '</tool_call>'.length };
  if (rest.startsWith('<tool_call>')) return { bodyEnd, resume: j };
  const tag = /^<\/[\w:-]+>/.exec(rest);
  if (tag) return { bodyEnd, resume: j + tag[0].length };
  // Could still become one of the tags above once more text arrives.
  if ('</tool_call>'.startsWith(rest) || '<tool_call>'.startsWith(rest) || /^<\/[\w:-]*$/.test(rest)) return null;
  return { bodyEnd, resume: bodyEnd };
}

/**
 * Drain any text still buffered by parseTextToolCallsStream. Call exactly
 * once at end-of-stream. If a tool-call body was opened but never closed,
 * the captured prefix + body is emitted as plain text so the user at least
 * sees what the model produced.
 */
export function* flushTextToolCallsStream(state: TextToolCallState): Generator<StreamEvent> {
  if (state.inBody) {
    const prefix = state.bodyKind === 'fn' ? `<function=${state.bodyToolName}>` : '<tool_call>';
    if (state.buffer.length > 0 || prefix.length > 0) {
      yield { type: 'text', text: prefix + state.buffer };
    }
    state.buffer = '';
    state.inBody = false;
    state.bodyKind = null;
    state.bodyToolName = null;
    return;
  }
  if (state.buffer.length > 0) {
    yield { type: 'text', text: state.buffer };
    state.buffer = '';
  }
}

/**
 * The value of a `<parameter=key>value</parameter>` tag. ML-64 (#164): this
 * was `trim()`med, which stripped the first line's indentation and the
 * trailing blank lines from code passed as `content`. Only the framing
 * newline after the opening tag and before the closing tag (the Qwen3-coder
 * layout) is dropped from a multi-line value; a single-line value (a path, a
 * number) is still trimmed.
 */
export function xmlParameterValue(raw: string): string {
  const value = raw.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  return /[\r\n]/.test(value) ? value : value.trim();
}

function parseToolCallBody(
  kind: 'fn' | 'tc',
  toolName: string | null,
  body: string,
  state: TextToolCallState,
): ToolUseContentBlock | null {
  if (kind === 'fn') {
    const input: Record<string, unknown> = {};
    const paramPattern = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = paramPattern.exec(body)) !== null) {
      input[pm[1]] = xmlParameterValue(pm[2]);
    }
    return {
      type: 'tool_use',
      id: `stream_tc_${state.idCounter.n++}`,
      name: toolName!,
      input,
    };
  }

  // tool_call JSON body
  try {
    const parsed = JSON.parse(body.trim()) as Record<string, unknown>;
    const fn = parsed.function as { name?: string; arguments?: unknown } | undefined;
    const name = (parsed.name as string) || fn?.name;
    const rawArgs = parsed.arguments ?? fn?.arguments ?? parsed.parameters ?? {};
    if (!name || !state.toolNames.has(name)) return null;
    const input =
      typeof rawArgs === 'string'
        ? (JSON.parse(rawArgs) as Record<string, unknown>)
        : (rawArgs as Record<string, unknown>);
    return {
      type: 'tool_use',
      id: `stream_tc_${state.idCounter.n++}`,
      name,
      input,
    };
  } catch {
    // ML-58 (#164): malformed JSON (raw newlines inside a string value, most
    // often) was dropped here, before repair could see it. Mirror the
    // post-stream parser: salvage a known tool name and hand the raw body on
    // as `_malformedInputRaw` for constrained repair. Only a body whose object
    // closes at its end: an unclosed one is cut off, or its `</tool_call>` was
    // inside a string (ML-61), and repair would close and run the prefix.
    const raw = body.trim();
    if (!raw.startsWith('{') || findBalancedEnd(raw, 0, { dialect: 'json' }) !== raw.length - 1) return null;
    const m = raw.match(/"(?:name|function)"\s*:\s*"(\w+)"/);
    if (!m || !state.toolNames.has(m[1])) return null;
    return {
      type: 'tool_use',
      id: `stream_tc_${state.idCounter.n++}`,
      name: m[1],
      input: {},
      _malformedInputRaw: raw,
    };
  }
}

// ---------------------------------------------------------------------------
// Abortable stream reader
// ---------------------------------------------------------------------------

/**
 * Race a ReadableStreamDefaultReader.read() against an AbortSignal.
 *
 * `reader.read()` does not accept a signal, so once the initial `fetch`
 * resolves (headers received) the abort signal no longer interrupts body
 * reading.  This helper bridges that gap by rejecting with an AbortError
 * when the signal fires.
 */
export function abortableRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();

  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
