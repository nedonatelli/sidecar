import { describe, it, expect } from 'vitest';
import { getContentText, getContentLength, serializeContent } from './types.js';
import type { ContentBlock } from './types.js';

describe('getContentText', () => {
  it('returns string content as-is', () => {
    expect(getContentText('hello world')).toBe('hello world');
  });

  it('extracts text from text content blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ];
    expect(getContentText(blocks)).toBe('Hello\nWorld');
  });

  it('ignores non-text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'visible' },
      { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_result', tool_use_id: 'tc1', content: 'file contents' },
    ];
    expect(getContentText(blocks)).toBe('visible');
  });

  it('returns empty string for empty array', () => {
    expect(getContentText([])).toBe('');
  });
});

describe('getContentLength', () => {
  it('returns length for string content', () => {
    expect(getContentLength('hello')).toBe(5);
  });

  it('sums text block lengths', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'abc' },
      { type: 'text', text: 'de' },
    ];
    expect(getContentLength(blocks)).toBe(5);
  });

  it('includes tool_result content length', () => {
    const blocks: ContentBlock[] = [{ type: 'tool_result', tool_use_id: 'tc1', content: '12345' }];
    expect(getContentLength(blocks)).toBe(5);
  });

  it('includes tool_use name and input size', () => {
    const blocks: ContentBlock[] = [{ type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }];
    // name ("read_file" = 9) + input value ("a.ts" = 4) = 13
    expect(getContentLength(blocks)).toBe(13);
  });

  it('returns 0 for empty array', () => {
    expect(getContentLength([])).toBe(0);
  });
});

describe('serializeContent', () => {
  it('returns string content as-is', () => {
    expect(serializeContent('hello')).toBe('hello');
  });

  it('preserves text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ];
    const result = serializeContent(blocks);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('preserves tool_use blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Let me read that file' },
      { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'src/app.ts' } },
    ];
    const result = serializeContent(blocks) as ContentBlock[];
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe('tool_use');
    expect((result[1] as { name: string }).name).toBe('read_file');
  });

  it('preserves tool_result blocks', () => {
    const blocks: ContentBlock[] = [{ type: 'tool_result', tool_use_id: 'tc1', content: 'file contents here' }];
    const result = serializeContent(blocks) as ContentBlock[];
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_result');
  });

  it('truncates large tool_result content', () => {
    const longContent = 'x'.repeat(5000);
    const blocks: ContentBlock[] = [{ type: 'tool_result', tool_use_id: 'tc1', content: longContent }];
    const result = serializeContent(blocks) as ContentBlock[];
    const resultBlock = result[0] as { type: string; content: string };
    expect(resultBlock.content.length).toBeLessThan(longContent.length);
    expect(resultBlock.content).toContain('(truncated)');
  });

  it('strips image blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Here is an image' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' },
      },
    ];
    const result = serializeContent(blocks);
    // Single text block remaining → flattened to string
    expect(result).toBe('Here is an image');
  });

  it('preserves thinking blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'Let me analyze this...' },
      { type: 'text', text: 'Here is my answer' },
    ];
    const result = serializeContent(blocks) as ContentBlock[];
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('thinking');
  });

  it('flattens single text block to string', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'just text' }];
    const result = serializeContent(blocks);
    expect(result).toBe('just text');
  });

  it('returns empty array for empty input', () => {
    const result = serializeContent([]);
    expect(result).toEqual([]);
  });
});
