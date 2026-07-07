import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseThinkTags,
  parseTextToolCallsStream,
  flushTextToolCallsStream,
  createTextToolCallState,
  type ThinkTagState,
} from './streamUtils.js';
import { translateAnthropicStream } from './anthropicStreamTranslate.js';
import { streamOpenAiSse } from './openAiSseStream.js';
import type { ToolDefinition } from './types.js';

// Fuzz suite for the streaming-parse layer — the code that turns raw, chunked,
// malformed-prone MODEL OUTPUT into structured events. A throw or hang here
// crashes an agent turn, so these assert totality (no throw) and termination
// (the test times out if a parser loops) over adversarial input. Also the first
// tests for anthropicStreamTranslate.ts, which previously had none.

const TOOLS: ToolDefinition[] = ['read_file', 'grep', 'write_file'].map((name) => ({
  name,
  description: `${name} tool`,
  input_schema: { type: 'object', properties: {} },
}));

/** Every yielded StreamEvent must at least carry a discriminant `type`. */
function assertWellFormed(ev: { type?: unknown }) {
  expect(typeof ev.type).toBe('string');
}

describe('streamUtils generators — fuzz (chunked model output)', () => {
  it('parseThinkTags never throws over a random chunk sequence', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: 'binary' }), { maxLength: 40 }), (chunks) => {
        const state: ThinkTagState = { insideThinkTag: false };
        for (const c of chunks) for (const ev of parseThinkTags(c, state)) assertWellFormed(ev);
      }),
      { numRuns: 500 },
    );
  });

  it('parseTextToolCallsStream + flush never throw over a random chunk sequence', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: 'binary' }), { maxLength: 40 }), (chunks) => {
        const state = createTextToolCallState(TOOLS);
        for (const c of chunks) for (const ev of parseTextToolCallsStream(c, state)) assertWellFormed(ev);
        for (const ev of flushTextToolCallsStream(state)) assertWellFormed(ev);
      }),
      { numRuns: 500 },
    );
  });

  it('handles adversarial tag/JSON fragments split across chunk boundaries', () => {
    // Tokens crafted to land the parser mid-tag / mid-JSON at every chunk edge.
    const frag = fc.constantFrom(
      '<think>',
      '</think>',
      '<tool_call>',
      '</tool_call>',
      '<function=read_file>',
      '</function>',
      '<parameter=path>',
      '</parameter>',
      '```json',
      '```',
      '{',
      '}',
      '"name"',
      ':',
      ',',
      'read_file',
      '\n',
      'x',
    );
    const chunks = fc.array(
      fc.array(frag, { maxLength: 12 }).map((a) => a.join('')),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(chunks, (cs) => {
        const think: ThinkTagState = { insideThinkTag: false };
        const tc = createTextToolCallState(TOOLS);
        for (const c of cs) {
          for (const ev of parseThinkTags(c, think)) assertWellFormed(ev);
          for (const ev of parseTextToolCallsStream(c, tc)) assertWellFormed(ev);
        }
        for (const ev of flushTextToolCallsStream(tc)) assertWellFormed(ev);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('translateAnthropicStream — fuzz (malformed Anthropic events)', () => {
  async function* asyncFrom<T>(items: T[]): AsyncGenerator<T> {
    for (const x of items) yield x;
  }

  const event = fc.record(
    {
      type: fc.constantFrom(
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
        'ping',
        'error',
        'totally_unknown_type',
      ),
      index: fc.option(fc.nat(), { nil: undefined }),
      delta: fc.option(
        fc.oneof(
          fc.record({ type: fc.constant('text_delta'), text: fc.string() }),
          fc.record({ type: fc.constant('input_json_delta'), partial_json: fc.string() }),
          fc.record({ type: fc.constant('thinking_delta'), thinking: fc.string() }),
          fc.record({ stop_reason: fc.option(fc.string(), { nil: null }) }),
          fc.record({ type: fc.string() }), // unknown delta shape
        ),
        { nil: undefined },
      ),
      content_block: fc.option(
        fc.record({ type: fc.string(), id: fc.string(), name: fc.string() }, { requiredKeys: [] }),
        { nil: undefined },
      ),
      message: fc.option(
        fc.record({
          usage: fc.record(
            {
              input_tokens: fc.option(fc.nat(), { nil: undefined }),
              output_tokens: fc.option(fc.nat(), { nil: undefined }),
            },
            { requiredKeys: [] },
          ),
        }),
        { nil: undefined },
      ),
    },
    { requiredKeys: ['type'] },
  );

  it('never throws while draining a random event stream', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(event, { maxLength: 40 }), async (events) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const ev of translateAnthropicStream(asyncFrom(events) as any, 'model')) assertWellFormed(ev);
      }),
      { numRuns: 300 },
    );
  });
});

describe('streamOpenAiSse — fuzz (malformed SSE frames)', () => {
  function mockResponse(text: string): Response {
    const bytes = new TextEncoder().encode(text);
    let sent = false;
    return {
      body: {
        getReader: () => ({
          read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    } as unknown as Response;
  }

  const sseLine = fc.constantFrom(
    'data: [DONE]',
    'data: {broken',
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"grep","arguments":"{"}}]}}]}',
    'data: null',
    'data: {}',
    'event: message',
    ': this is a comment',
    '',
    'garbage without prefix',
    'data:',
    'data: [',
  );

  it('never throws while draining random SSE frames', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(sseLine, { maxLength: 40 }), async (lines) => {
        const resp = mockResponse(lines.join('\n') + '\n');
        for await (const ev of streamOpenAiSse(resp, 'model', TOOLS, undefined)) assertWellFormed(ev);
      }),
      { numRuns: 300 },
    );
  });
});
