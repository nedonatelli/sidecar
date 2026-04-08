import type { StreamEvent, ToolDefinition } from './types.js';

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
