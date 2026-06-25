import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { excludeBlockedCircularRewrites } from './circularRewrite.js';
import { stubLoopState, stubCallbacks } from './testHelpers.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function write(path: string, content: string): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${path}-${content.length}`, name: 'write_file', input: { path, content } };
}

describe('excludeBlockedCircularRewrites', () => {
  it('passes everything through when no write history exists', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const tus = [write('gui.py', 'A')];
    expect(excludeBlockedCircularRewrites(tus, state, cb)).toEqual(tus);
  });

  it('keeps a write whose content has not been written before', () => {
    const state = stubLoopState();
    state.writeHistoryByFile.set('gui.py', new Set([hash('A')]));
    const cb = stubCallbacks();
    const tus = [write('gui.py', 'B')]; // new content
    expect(excludeBlockedCircularRewrites(tus, state, cb)).toHaveLength(1);
  });

  it('excludes a circular write (content identical to a prior write) from cycle detection', () => {
    const state = stubLoopState();
    state.writeHistoryByFile.set('gui.py', new Set([hash('A'), hash('B')]));
    const cb = stubCallbacks();
    const tus = [write('gui.py', 'A')]; // circular — A was written before
    const kept = excludeBlockedCircularRewrites(tus, state, cb);
    expect(kept).toHaveLength(0);
    expect(state.circularRewriteBlocksByFile.get('gui.py')).toBe(1);
    expect(cb.texts.join('')).toContain('blocked');
  });

  it('leaves non-write tools untouched even when a circular write is present', () => {
    const state = stubLoopState();
    state.writeHistoryByFile.set('gui.py', new Set([hash('A')]));
    const cb = stubCallbacks();
    const read: ToolUseContentBlock = { type: 'tool_use', id: 'r', name: 'read_file', input: { path: 'gui.py' } };
    const kept = excludeBlockedCircularRewrites([read, write('gui.py', 'A')], state, cb);
    expect(kept).toEqual([read]);
  });

  it('stops excluding after the per-file budget is spent so cycle detection can bail', () => {
    const state = stubLoopState();
    state.writeHistoryByFile.set('gui.py', new Set([hash('A')]));
    const cb = stubCallbacks();
    // 1st and 2nd circular writes are excluded; 3rd is kept (budget = 2).
    expect(excludeBlockedCircularRewrites([write('gui.py', 'A')], state, cb)).toHaveLength(0);
    expect(excludeBlockedCircularRewrites([write('gui.py', 'A')], state, cb)).toHaveLength(0);
    expect(excludeBlockedCircularRewrites([write('gui.py', 'A')], state, cb)).toHaveLength(1);
    expect(state.circularRewriteBlocksByFile.get('gui.py')).toBe(2);
  });

  it('handles file_path as the path key', () => {
    const state = stubLoopState();
    state.writeHistoryByFile.set('gui.py', new Set([hash('A')]));
    const cb = stubCallbacks();
    const tu: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu',
      name: 'write_file',
      input: { file_path: 'gui.py', content: 'A' },
    };
    expect(excludeBlockedCircularRewrites([tu], state, cb)).toHaveLength(0);
  });

  it('tracks budget per file independently', () => {
    const state = stubLoopState();
    state.writeHistoryByFile.set('a.py', new Set([hash('A')]));
    state.writeHistoryByFile.set('b.py', new Set([hash('B')]));
    const cb = stubCallbacks();
    excludeBlockedCircularRewrites([write('a.py', 'A')], state, cb);
    expect(state.circularRewriteBlocksByFile.get('a.py')).toBe(1);
    expect(state.circularRewriteBlocksByFile.has('b.py')).toBe(false);
  });
});
