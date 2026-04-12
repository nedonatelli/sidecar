import type { StreamEvent, ToolDefinition, ToolUseContentBlock } from './types.js';

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
      const endTag = state.bodyKind === 'fn' ? '</function>' : '</tool_call>';
      const endIdx = state.buffer.indexOf(endTag);
      if (endIdx === -1) {
        // Keep collecting the body — don't emit anything.
        return;
      }

      const body = state.buffer.substring(0, endIdx);
      state.buffer = state.buffer.substring(endIdx + endTag.length);

      const toolUse = parseToolCallBody(state.bodyKind!, state.bodyToolName, body, state);
      if (toolUse) {
        yield { type: 'tool_use', toolUse };
      }
      // If parsing failed we silently drop — matches post-stream parser behavior.

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
      input[pm[1]] = pm[2].trim();
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
    return null;
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
