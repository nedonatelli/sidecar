import { describe, it, expect } from 'vitest';
import { getContentText, getContentLength } from './types.js';
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

  it('includes tool_use input JSON length', () => {
    const blocks: ContentBlock[] = [{ type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }];
    const inputLen = JSON.stringify({ path: 'a.ts' }).length;
    expect(getContentLength(blocks)).toBe(inputLen);
  });

  it('returns 0 for empty array', () => {
    expect(getContentLength([])).toBe(0);
  });
});
