import { describe, it, expect } from 'vitest';
import { parseEditBlocks } from './parser.js';

describe('parseEditBlocks', () => {
  it('parses a single edit block', () => {
    const text = `Some text
<<<SEARCH:src/app.ts
const x = 1;
===
const x = 2;
>>>REPLACE
More text`;
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe('src/app.ts');
    expect(blocks[0].searchText).toBe('const x = 1;');
    expect(blocks[0].replaceText).toBe('const x = 2;');
  });

  it('parses multiple edit blocks', () => {
    const text = `<<<SEARCH:a.ts
old1
===
new1
>>>REPLACE
text between
<<<SEARCH:b.ts
old2
===
new2
>>>REPLACE`;
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].filePath).toBe('a.ts');
    expect(blocks[1].filePath).toBe('b.ts');
  });

  it('returns empty array for no edit blocks', () => {
    expect(parseEditBlocks('no edits here')).toEqual([]);
  });

  it('handles multi-line search and replace', () => {
    const text = `<<<SEARCH:file.ts
line 1
line 2
line 3
===
new line 1
new line 2
>>>REPLACE`;
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].searchText).toBe('line 1\nline 2\nline 3');
    expect(blocks[0].replaceText).toBe('new line 1\nnew line 2');
  });

  it('handles empty replace (deletion)', () => {
    const text = `<<<SEARCH:file.ts
delete me
===

>>>REPLACE`;
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].replaceText).toBe('');
  });

  it('trims file path', () => {
    const text = `<<<SEARCH:  src/file.ts
old
===
new
>>>REPLACE`;
    const blocks = parseEditBlocks(text);
    expect(blocks[0].filePath).toBe('src/file.ts');
  });
});
