import { describe, it, expect } from 'vitest';
import { parseThinkTags, toFunctionTools, type ThinkTagState } from './streamUtils.js';
import type { StreamEvent, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// parseThinkTags
// ---------------------------------------------------------------------------

describe('parseThinkTags', () => {
  function collect(content: string, state?: ThinkTagState): StreamEvent[] {
    const s = state ?? { insideThinkTag: false };
    return [...parseThinkTags(content, s)];
  }

  it('emits plain text when no think tags present', () => {
    const events = collect('Hello world');
    expect(events).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('parses a complete <think> block in one chunk', () => {
    const events = collect('<think>reasoning</think>answer');
    expect(events).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('handles text before and after think tags', () => {
    const events = collect('before<think>thinking</think>after');
    expect(events).toEqual([
      { type: 'text', text: 'before' },
      { type: 'thinking', thinking: 'thinking' },
      { type: 'text', text: 'after' },
    ]);
  });

  it('handles unclosed think tag across chunks', () => {
    const state: ThinkTagState = { insideThinkTag: false };

    const events1 = [...parseThinkTags('<think>partial', state)];
    expect(events1).toEqual([{ type: 'thinking', thinking: 'partial' }]);
    expect(state.insideThinkTag).toBe(true);

    const events2 = [...parseThinkTags(' more</think>done', state)];
    expect(events2).toEqual([
      { type: 'thinking', thinking: ' more' },
      { type: 'text', text: 'done' },
    ]);
    expect(state.insideThinkTag).toBe(false);
  });

  it('handles empty content', () => {
    const events = collect('');
    expect(events).toEqual([]);
  });

  it('handles think tag with no content', () => {
    const events = collect('<think></think>');
    expect(events).toEqual([]);
  });

  it('handles multiple think blocks', () => {
    const events = collect('a<think>t1</think>b<think>t2</think>c');
    expect(events).toEqual([
      { type: 'text', text: 'a' },
      { type: 'thinking', thinking: 't1' },
      { type: 'text', text: 'b' },
      { type: 'thinking', thinking: 't2' },
      { type: 'text', text: 'c' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// toFunctionTools
// ---------------------------------------------------------------------------

describe('toFunctionTools', () => {
  it('converts ToolDefinition[] to function calling format', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ];

    const result = toFunctionTools(tools);
    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ]);
  });

  it('handles empty array', () => {
    expect(toFunctionTools([])).toEqual([]);
  });

  it('handles tools without required fields', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'list_dir',
        description: 'List directory',
        input_schema: { type: 'object', properties: {} },
      },
    ];

    const result = toFunctionTools(tools);
    expect(result[0].function.parameters.required).toBeUndefined();
  });
});
