import { describe, it, expect } from 'vitest';
import { applyIdenticalEditReprompt } from './identicalEditReprompt.js';
import { stubLoopState, stubCallbacks } from './testHelpers.js';
import type { ToolResultContentBlock, ToolUseContentBlock } from '../../ollama/types.js';

function use(id: string, input: Record<string, unknown>, name = 'edit_file'): ToolUseContentBlock {
  return { type: 'tool_use', id, name, input } as ToolUseContentBlock;
}
function err(id: string, content: string): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: id, content, is_error: true } as ToolResultContentBlock;
}
function ok(id: string, content = '<tool_output tool="edit_file">File edited</tool_output>'): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: id, content } as ToolResultContentBlock;
}

const IDENTICAL = 'Error: edit_file failed — search and replace text are identical; no change would be made.';
const AGAIN = 'Error: edit_file failed AGAIN — you resubmitted the EXACT SAME search and replace.';

describe('applyIdenticalEditReprompt', () => {
  it('nudges once, quoting the region the model already found', () => {
    const state = stubLoopState();
    const fired = applyIdenticalEditReprompt(
      state,
      [use('1', { path: 'src/a.py', search: 'def total(x):', replace: 'def total(x):' })],
      [err('1', IDENTICAL)],
      stubCallbacks(),
    );

    expect(fired).toBe(true);
    const text = String((state.messages.at(-1)?.content as { text: string }[])[0].text);
    // It must hand back the located text — the model has the place, not the change.
    expect(text).toContain('def total(x):');
    expect(text).toContain('src/a.py');
    expect(text).toMatch(/must differ|CHANGED/);
  });

  it('fires on the AGAIN escalation too', () => {
    const state = stubLoopState();
    const fired = applyIdenticalEditReprompt(
      state,
      [use('1', { path: 'src/a.py', search: 'x = 1', replace: 'x = 1' })],
      [err('1', AGAIN)],
      stubCallbacks(),
    );
    expect(fired).toBe(true);
  });

  it('nudges a given file only once, so an unresponsive model falls through', () => {
    // The existing AGAIN escalation and cycle detection are the backstops. A
    // nudge that repeats every turn would just be another thing to ignore.
    const state = stubLoopState();
    const call = [use('1', { path: 'src/a.py', search: 'x = 1', replace: 'x = 1' })];
    expect(applyIdenticalEditReprompt(state, call, [err('1', IDENTICAL)], stubCallbacks())).toBe(true);
    expect(applyIdenticalEditReprompt(state, call, [err('1', IDENTICAL)], stubCallbacks())).toBe(false);
  });

  it('stays silent on a successful edit', () => {
    const state = stubLoopState();
    const fired = applyIdenticalEditReprompt(
      state,
      [use('1', { path: 'src/a.py', search: 'x = 1', replace: 'x = 2' })],
      [ok('1')],
      stubCallbacks(),
    );
    expect(fired).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  it('stays silent on a different edit_file failure', () => {
    // "not found" means the model has the WRONG place. Telling it that it
    // already found the right one would be false and would steer it wrong.
    const state = stubLoopState();
    const fired = applyIdenticalEditReprompt(
      state,
      [use('1', { path: 'src/a.py', search: 'nope', replace: 'yes' })],
      [err('1', 'Error: edit_file failed — search string not found in src/a.py.')],
      stubCallbacks(),
    );
    expect(fired).toBe(false);
  });

  it('ignores non-edit tools', () => {
    const state = stubLoopState();
    const fired = applyIdenticalEditReprompt(
      state,
      [use('1', { path: 'src/a.py' }, 'read_file')],
      [err('1', IDENTICAL)],
      stubCallbacks(),
    );
    expect(fired).toBe(false);
  });
});
