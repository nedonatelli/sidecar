import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  excludeBlockedCircularRewrites,
  resetVerifyCountersForVerifications,
  recordSuccessfulEdits,
  shouldDeferBailForBlockedWrite,
  clearTrackingForDeletedFiles,
  captureLastFailureOutput,
  maybeEscalateBlockedRewrite,
  maybeSteerEditToWrite,
  maybeReleaseEnforceLock,
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

describe('shouldDeferBailForBlockedWrite', () => {
  it('defers a bail when a pending write would be verify-blocked (rewritten ≥3× unverified)', () => {
    const state = stubLoopState();
    state.writesSinceVerifyByFile.set('gui.py', 3); // executor will block the 4th write
    const cb = stubCallbacks();
    expect(shouldDeferBailForBlockedWrite([write('gui.py', 'v4')], state, cb)).toBe(true);
    expect(state.forceVerifyBeforeBailByFile.get('gui.py')).toBe(1);
  });

  it('defers a bail when a pending write targets an enforce-edit-locked file', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('gui.py'); // any write_file to it will be enforce-blocked
    const cb = stubCallbacks();
    expect(shouldDeferBailForBlockedWrite([write('gui.py', 'whole new file')], state, cb)).toBe(true);
    expect(cb.texts.join('')).toContain('edit_file');
  });

  it('does NOT defer when the write would not be blocked', () => {
    const state = stubLoopState();
    state.writesSinceVerifyByFile.set('gui.py', 2); // under threshold, not edited
    const cb = stubCallbacks();
    expect(shouldDeferBailForBlockedWrite([write('gui.py', 'v3')], state, cb)).toBe(false);
  });

  it('stops deferring after the per-file budget is spent so the run can bail', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('gui.py');
    const cb = stubCallbacks();
    expect(shouldDeferBailForBlockedWrite([write('gui.py', 'a')], state, cb)).toBe(true); // 1
    expect(shouldDeferBailForBlockedWrite([write('gui.py', 'b')], state, cb)).toBe(true); // 2
    expect(shouldDeferBailForBlockedWrite([write('gui.py', 'c')], state, cb)).toBe(false); // budget spent
  });

  it('ignores non-write tools', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('gui.py');
    const cb = stubCallbacks();
    expect(shouldDeferBailForBlockedWrite([tool('read_file', { path: 'gui.py' })], state, cb)).toBe(false);
  });
});

describe('captureLastFailureOutput', () => {
  const result = (content: string): ToolResultContentBlock => ({ type: 'tool_result', tool_use_id: 'id', content });

  it('captures a failing test run output (traceback)', () => {
    const state = stubLoopState();
    captureLastFailureOutput(
      [tool('run_tests', { file: 'test_gui.py' })],
      [result('Traceback (most recent call last):\n  TclError: cannot use geometry manager grid')],
      state,
    );
    expect(state.lastFailureOutput).toContain('cannot use geometry manager');
  });

  it('strips ANSI codes and the tool_output wrapper', () => {
    const state = stubLoopState();
    captureLastFailureOutput(
      [tool('run_command', { command: 'pytest' })],
      [result('<tool_output tool="run_command">\n\x1b[1m1 failed\x1b[0m AssertionError</tool_output>')],
      state,
    );
    expect(state.lastFailureOutput).not.toContain('\x1b');
    expect(state.lastFailureOutput).not.toContain('tool_output');
    expect(state.lastFailureOutput).toContain('AssertionError');
  });

  it('does NOT capture passing output (no failure markers)', () => {
    const state = stubLoopState();
    captureLastFailureOutput([tool('run_tests', { file: 't.py' })], [result('5 passed in 0.05s')], state);
    expect(state.lastFailureOutput).toBeUndefined();
  });
});

describe('maybeEscalateBlockedRewrite', () => {
  const blocked = (): ToolResultContentBlock => ({
    type: 'tool_result',
    tool_use_id: 'id',
    content: 'write_file to `gui.py` was NOT applied. You have been making targeted edits…',
  });
  const applied = (): ToolResultContentBlock => ({
    type: 'tool_result',
    tool_use_id: 'id',
    content: 'File written: gui.py',
  });

  it('injects one escalation reprompt with the failing output when a write was enforce-blocked', () => {
    const state = stubLoopState();
    state.lastFailureOutput = 'TclError: cannot use geometry manager grid inside .';
    const cb = stubCallbacks();
    const fired = maybeEscalateBlockedRewrite([write('gui.py', 'x')], [blocked()], state, cb);
    expect(fired).toBe(true);
    expect(state.messages).toHaveLength(1);
    const text = (state.messages[0].content as { text: string }[])[0].text;
    expect(text).toContain('STOP calling write_file');
    expect(text).toContain('cannot use geometry manager');
    expect(text).toContain('edit_file');
  });

  it('only escalates once per file', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    expect(maybeEscalateBlockedRewrite([write('gui.py', 'x')], [blocked()], state, cb)).toBe(true);
    expect(maybeEscalateBlockedRewrite([write('gui.py', 'y')], [blocked()], state, cb)).toBe(false);
    expect(state.messages).toHaveLength(1);
  });

  it('does NOT escalate on an applied write', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    expect(maybeEscalateBlockedRewrite([write('gui.py', 'x')], [applied()], state, cb)).toBe(false);
  });
});

describe('maybeSteerEditToWrite', () => {
  const edit = (path: string): ToolUseContentBlock => ({
    type: 'tool_use',
    id: `e-${path}`,
    name: 'edit_file',
    input: { path, search: 'x', insert_after: 'x' },
  });
  const editErr = (): ToolResultContentBlock => ({
    type: 'tool_result',
    tool_use_id: 'id',
    is_error: true,
    content: "Error: your 'insert_after' text is identical to your 'search' anchor…",
  });
  const editOk = (): ToolResultContentBlock => ({
    type: 'tool_result',
    tool_use_id: 'id',
    content: 'File edited: calculator.py',
  });
  // The steer ships default-OFF (unproven benefit), so tests of the firing logic
  // must opt in explicitly; a config without the flag must NOT fire (see below).
  const ENABLED = { config: { editToWriteSteerEnabled: true } as never };

  it('is OFF by default — a config without the flag never fires', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 5; i++) maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb);
    expect(state.messages).toHaveLength(0);
  });

  it('does not fire before the threshold of failures', () => {
    const state = stubLoopState(ENABLED);
    const cb = stubCallbacks();
    expect(maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb)).toBe(false);
    expect(maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb)).toBe(false);
    expect(state.editFailureCountByFile.get('calculator.py')).toBe(2);
    expect(state.messages).toHaveLength(0);
  });

  it('fires on the 3rd consecutive edit_file failure and steers to write_file', () => {
    const state = stubLoopState(ENABLED);
    const cb = stubCallbacks();
    maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb);
    maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb);
    const fired = maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb);
    expect(fired).toBe(true);
    expect(state.messages).toHaveLength(1);
    const text = (state.messages[0].content as { text: string }[])[0].text;
    expect(text).toContain('STOP calling edit_file');
    expect(text).toContain('write_file');
    expect(text).toContain('COMPLETE file');
  });

  it('only steers once per file', () => {
    const state = stubLoopState(ENABLED);
    const cb = stubCallbacks();
    for (let i = 0; i < 5; i++) maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb);
    expect(state.messages).toHaveLength(1);
  });

  it('a successful edit resets the failure streak', () => {
    const state = stubLoopState(ENABLED);
    const cb = stubCallbacks();
    maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb);
    maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb);
    maybeSteerEditToWrite([edit('calculator.py')], [editOk()], state, cb); // reset
    expect(state.editFailureCountByFile.has('calculator.py')).toBe(false);
    expect(maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb)).toBe(false); // count=1 again
  });

  it('is disabled when editToWriteSteerEnabled is false', () => {
    const state = stubLoopState({ config: { editToWriteSteerEnabled: false } as never });
    const cb = stubCallbacks();
    for (let i = 0; i < 5; i++) maybeSteerEditToWrite([edit('calculator.py')], [editErr()], state, cb);
    expect(state.messages).toHaveLength(0);
  });

  it('counts failures per file independently', () => {
    const state = stubLoopState(ENABLED);
    const cb = stubCallbacks();
    maybeSteerEditToWrite([edit('a.py')], [editErr()], state, cb);
    maybeSteerEditToWrite([edit('b.py')], [editErr()], state, cb);
    expect(state.editFailureCountByFile.get('a.py')).toBe(1);
    expect(state.editFailureCountByFile.get('b.py')).toBe(1);
    expect(state.messages).toHaveLength(0);
  });
});

describe('maybeReleaseEnforceLock', () => {
  const blocked = (): ToolResultContentBlock => ({
    type: 'tool_result',
    tool_use_id: 'id',
    content: 'write_file to `gui.py` was NOT applied. You have been making targeted edits…',
  });
  const applied = (): ToolResultContentBlock => ({
    type: 'tool_result',
    tool_use_id: 'id',
    content: 'File written: gui.py',
  });

  it('releases the enforce-edit lock after MAX_ENFORCE_EDIT_BLOCKS blocked rewrites', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('gui.py');
    const cb = stubCallbacks();
    maybeReleaseEnforceLock([write('gui.py', 'a')], [blocked()], state, cb); // 1
    maybeReleaseEnforceLock([write('gui.py', 'b')], [blocked()], state, cb); // 2
    expect(state.filesEditedViaEditTool.has('gui.py')).toBe(true); // still locked at 2
    maybeReleaseEnforceLock([write('gui.py', 'c')], [blocked()], state, cb); // 3 → release
    expect(state.filesEditedViaEditTool.has('gui.py')).toBe(false); // released
    expect(cb.texts.join('')).toContain('rewrite');
  });

  it('does NOT count an applied write toward the block budget', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('gui.py');
    const cb = stubCallbacks();
    for (let i = 0; i < 5; i++) maybeReleaseEnforceLock([write('gui.py', `v${i}`)], [applied()], state, cb);
    expect(state.filesEditedViaEditTool.has('gui.py')).toBe(true); // never released
    expect(state.enforceEditBlocksByFile.get('gui.py') ?? 0).toBe(0);
  });

  it('matches the locked file by path suffix (relative vs absolute)', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('/abs/proj/gui.py');
    const cb = stubCallbacks();
    for (let i = 0; i < 3; i++) maybeReleaseEnforceLock([write('gui.py', `v${i}`)], [blocked()], state, cb);
    expect([...state.filesEditedViaEditTool]).not.toContain('/abs/proj/gui.py'); // released by suffix
  });

  it('does NOT release a same-basename file in a different dir', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('src/util.py');
    const cb = stubCallbacks();
    // Blocked writes target test/util.py — must not release the lock on src/util.py.
    for (let i = 0; i < 4; i++) maybeReleaseEnforceLock([write('test/util.py', `v${i}`)], [blocked()], state, cb);
    expect(state.filesEditedViaEditTool.has('src/util.py')).toBe(true);
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

  it('does NOT record a failed edit whose Error is behind an "[You have not read…]" prefix (Bug 1)', () => {
    const state = stubLoopState();
    // editFile prepends unreadPrefix, so the result does NOT start with "Error:".
    const prefixed = okResult(
      '[You have not read gui.py this turn. …]\n\nError: edit_file failed — search string not found in gui.py. The file was NOT modified.',
    );
    recordSuccessfulEdits([tool('edit_file', { path: 'gui.py' })], [prefixed], state);
    expect(state.filesEditedViaEditTool.size).toBe(0);
  });

  it('DOES record a real edit whose "File edited:" success is behind an unread prefix', () => {
    const state = stubLoopState();
    const prefixed = okResult('[You have not read gui.py this turn. …]\n\nFile edited: gui.py');
    recordSuccessfulEdits([tool('edit_file', { path: 'gui.py' })], [prefixed], state);
    expect(state.filesEditedViaEditTool.has('gui.py')).toBe(true);
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

  it('clears all per-file tracking on a successful delete_file (delete-to-restart escape)', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('test_gui.py');
    state.writeHistoryByFile.set('test_gui.py', new Set([hash('A')]));
    state.writesSinceVerifyByFile.set('test_gui.py', 3);
    state.circularRewriteBlocksByFile.set('test_gui.py', 2);
    state.forceVerifyBeforeBailByFile.set('test_gui.py', 1);
    // an unrelated file's tracking must survive
    state.filesEditedViaEditTool.add('gui.py');

    clearTrackingForDeletedFiles(
      [tool('delete_file', { path: 'test_gui.py' })],
      [okResult('File deleted: test_gui.py')],
      state,
    );

    expect(state.filesEditedViaEditTool.has('test_gui.py')).toBe(false);
    expect(state.writeHistoryByFile.has('test_gui.py')).toBe(false);
    expect(state.writesSinceVerifyByFile.has('test_gui.py')).toBe(false);
    expect(state.circularRewriteBlocksByFile.has('test_gui.py')).toBe(false);
    expect(state.forceVerifyBeforeBailByFile.has('test_gui.py')).toBe(false);
    expect(state.filesEditedViaEditTool.has('gui.py')).toBe(true); // unrelated file untouched
  });

  it('also purges enforceEditBlocksByFile and escalatedRewriteByFile (delete-to-restart fresh slate)', () => {
    const state = stubLoopState();
    state.enforceEditBlocksByFile.set('test_gui.py', 2);
    state.escalatedRewriteByFile.add('test_gui.py');
    clearTrackingForDeletedFiles(
      [tool('delete_file', { path: 'test_gui.py' })],
      [okResult('File deleted: test_gui.py')],
      state,
    );
    expect(state.enforceEditBlocksByFile.has('test_gui.py')).toBe(false);
    expect(state.escalatedRewriteByFile.has('test_gui.py')).toBe(false);
  });

  it('does NOT cross-clear a same-basename file in a different dir', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('src/util.py');
    state.filesEditedViaEditTool.add('test/util.py');
    clearTrackingForDeletedFiles(
      [tool('delete_file', { path: 'test/util.py' })],
      [okResult('File deleted: test/util.py')],
      state,
    );
    expect(state.filesEditedViaEditTool.has('src/util.py')).toBe(true); // untouched
    expect(state.filesEditedViaEditTool.has('test/util.py')).toBe(false);
  });

  it('does NOT clear tracking on a failed delete_file', () => {
    const state = stubLoopState();
    state.filesEditedViaEditTool.add('test_gui.py');
    clearTrackingForDeletedFiles([tool('delete_file', { path: 'test_gui.py' })], [errResult()], state);
    expect(state.filesEditedViaEditTool.has('test_gui.py')).toBe(true);
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
