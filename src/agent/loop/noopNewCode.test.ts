import { describe, it, expect, vi } from 'vitest';
import { applyNoopNewCode, firstCodeBlock, NOOP_NEW_CODE_ID_PREFIX } from './noopNewCode.js';
import { stubLoopState } from './testHelpers.js';
import type { TurnResult } from './streamTurn.js';
import type { AgentCallbacks } from '../loop.js';

const callbacks = () => ({ onText: vi.fn(), onToolCall: vi.fn() }) as unknown as AgentCallbacks;
const turn = (fullText: string, extra: Partial<TurnResult> = {}): TurnResult =>
  ({ fullText, pendingToolUses: [], stopReason: 'end_turn', terminated: false, ...extra }) as TurnResult;
const pendingState = () => {
  const state = stubLoopState();
  state.noopNewCodeRef.pending = { path: 'src/a.py', search: 'def f():\n    return 1' };
  return state;
};

describe('applyNoopNewCode (#328)', () => {
  it('turns the code block the no-op asked for into edit_file(search, block)', () => {
    const state = pendingState();
    const cb = callbacks();
    const resolved = turn('Here it is:\n```python\ndef f():\n    return 2\n```\n', {
      fenceWrite: { path: 'src/a.py', content: 'def f():\n    return 2' },
      printedCode: { path: 'src/a.py', code: 'def f():\n    return 2' },
    });
    expect(applyNoopNewCode(resolved, state, cb)).toBe(true);
    expect(resolved.pendingToolUses).toEqual([
      expect.objectContaining({
        name: 'edit_file',
        input: { path: 'src/a.py', search: 'def f():\n    return 1', replace: 'def f():\n    return 2' },
      }),
    ]);
    expect(resolved.pendingToolUses[0].id.startsWith(NOOP_NEW_CODE_ID_PREFIX)).toBe(true);
    expect(resolved.stopReason).toBe('tool_use');
    // The same block must not also become a whole-file write.
    expect(resolved.fenceWrite).toBeUndefined();
    expect(resolved.printedCode).toBeUndefined();
    expect(state.noopNewCodeRef.pending).toBeNull();
    expect(cb.onToolCall).toHaveBeenCalledOnce();
  });

  it('does nothing without a pending no-op', () => {
    const state = stubLoopState();
    const resolved = turn('```\nx = 2\n```');
    expect(applyNoopNewCode(resolved, state, callbacks())).toBe(false);
    expect(resolved.pendingToolUses).toEqual([]);
  });

  it('a turn that called a tool drops the pending no-op and adds nothing', () => {
    const state = pendingState();
    const call = { type: 'tool_use' as const, id: 't1', name: 'read_file', input: { path: 'src/a.py' } };
    const resolved = turn('```\ndef f():\n    return 2\n```', { pendingToolUses: [call], stopReason: 'tool_use' });
    expect(applyNoopNewCode(resolved, state, callbacks())).toBe(false);
    expect(resolved.pendingToolUses).toEqual([call]);
    expect(state.noopNewCodeRef.pending).toBeNull();
  });

  it('a reply with no code block, or one that repeats the search, applies nothing and is not retried', () => {
    for (const text of ['I will think about it.', '```py\ndef f():\n        return 1\n```']) {
      const state = pendingState();
      const resolved = turn(text);
      expect(applyNoopNewCode(resolved, state, callbacks())).toBe(false);
      expect(resolved.pendingToolUses).toEqual([]);
      expect(state.noopNewCodeRef.pending).toBeNull();
    }
  });

  it('firstCodeBlock takes the first fence, without its final newline', () => {
    expect(firstCodeBlock('a\n```js\nx\ny\n```\n```\nz\n```')).toBe('x\ny');
    expect(firstCodeBlock('```\r\nx\r\n```')).toBe('x');
    expect(firstCodeBlock('no fence')).toBeNull();
  });
});
