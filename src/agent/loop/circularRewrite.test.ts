import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  excludeBlockedCircularRewrites,
  resetVerifyCountersForVerifications,
  recordSuccessfulEdits,
} from './circularRewrite.js';
import { stubLoopState, stubCallbacks } from './testHelpers.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function write(path: string, content: string): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${path}-${content.length}`, name: 'write_file', input: { path, content } };
}
function tool(name: string, input: Record<string, unknown>): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${name}`, name, input };
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

describe('resetVerifyCountersForVerifications', () => {
  it('clears every counter when get_diagnostics ran (it checks all edited files)', () => {
    const state = stubLoopState();
    state.writesSinceVerifyByFile.set('gui.py', 4);
    state.writesSinceVerifyByFile.set('app.py', 2);
    resetVerifyCountersForVerifications([tool('get_diagnostics', {})], state);
    expect(state.writesSinceVerifyByFile.size).toBe(0);
  });

  it('resets a file whose module name appears in a run_command', () => {
    const state = stubLoopState();
    state.writesSinceVerifyByFile.set('gui_calculator.py', 4);
    resetVerifyCountersForVerifications(
      [tool('run_command', { command: 'python3 -c "import gui_calculator"' })],
      state,
    );
    expect(state.writesSinceVerifyByFile.get('gui_calculator.py')).toBe(0);
  });

  it('resets a file referenced by a run_tests file arg', () => {
    const state = stubLoopState();
    state.writesSinceVerifyByFile.set('gui_calculator.py', 4);
    resetVerifyCountersForVerifications([tool('run_tests', { file: 'test_gui_calculator.py' })], state);
    expect(state.writesSinceVerifyByFile.get('gui_calculator.py')).toBe(0);
  });

  it('does NOT reset a file an unrelated test run never touched (target-coverage)', () => {
    const state = stubLoopState();
    state.writesSinceVerifyByFile.set('gui_calculator.py', 4);
    resetVerifyCountersForVerifications([tool('run_command', { command: 'pytest test_calculator.py' })], state);
    expect(state.writesSinceVerifyByFile.get('gui_calculator.py')).toBe(4);
  });

  it('is a no-op when there are no counters', () => {
    const state = stubLoopState();
    expect(() => resetVerifyCountersForVerifications([tool('get_diagnostics', {})], state)).not.toThrow();
  });
});

describe('recordSuccessfulEdits', () => {
  const okResult = (text = 'File edited: x'): ToolResultContentBlock => ({
    type: 'tool_result',
    tool_use_id: 'id',
    content: text,
  });
  const errResult = (text = 'boom'): ToolResultContentBlock => ({
    type: 'tool_result',
    tool_use_id: 'id',
    content: text,
    is_error: true,
  });

  it('records a file successfully edited via edit_file', () => {
    const state = stubLoopState();
    recordSuccessfulEdits([tool('edit_file', { path: 'gui.py', search: 'a', replace: 'b' })], [okResult()], state);
    expect(state.filesEditedViaEditTool.has('gui.py')).toBe(true);
  });

  it('does NOT record a failed edit (is_error result)', () => {
    const state = stubLoopState();
    recordSuccessfulEdits([tool('edit_file', { path: 'gui.py' })], [errResult()], state);
    expect(state.filesEditedViaEditTool.size).toBe(0);
  });

  it('does NOT record an edit whose result is a soft "Error:" string (search-not-found)', () => {
    const state = stubLoopState();
    const soft = okResult('Error: edit_file failed — search string not found in gui.py.');
    recordSuccessfulEdits([tool('edit_file', { path: 'gui.py' })], [soft], state);
    expect(state.filesEditedViaEditTool.size).toBe(0);
  });

  it('records an inferred-edit success', () => {
    const state = stubLoopState();
    recordSuccessfulEdits(
      [tool('edit_file', { path: 'gui.py' })],
      [okResult('Applied inferred edit to gui.py: …')],
      state,
    );
    expect(state.filesEditedViaEditTool.has('gui.py')).toBe(true);
  });

  it('ignores write_file and other tools', () => {
    const state = stubLoopState();
    recordSuccessfulEdits(
      [tool('write_file', { path: 'gui.py', content: 'x' })],
      [okResult('File written: gui.py')],
      state,
    );
    expect(state.filesEditedViaEditTool.size).toBe(0);
  });
});
