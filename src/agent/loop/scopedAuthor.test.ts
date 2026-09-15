import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { applyScopedAuthor, buildAuthorPrompt, extractReplacement, isNoOpEdit } from './scopedAuthor.js';
import { stubLoopState, stubCallbacks } from './testHelpers.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { ToolResultContentBlock, ToolUseContentBlock } from '../../ollama/types.js';

const IDENTICAL = 'Error: edit_file failed — search and replace text are identical; no change would be made.';
const REGION = 'def is_within_bounds(self, value):\n    return value <= self.maximum';

function use(id: string, input: Record<string, unknown>, name = 'edit_file'): ToolUseContentBlock {
  return { type: 'tool_use', id, name, input } as ToolUseContentBlock;
}
function err(id: string, content = IDENTICAL): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: id, content, is_error: true } as ToolResultContentBlock;
}
function ok(id: string): ToolResultContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: '<tool_output>File edited</tool_output>',
  } as ToolResultContentBlock;
}

/** A client that returns one canned completion and records what it was asked. */
function stubClient(reply: string | (() => never)): SideCarClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    routeForDispatch: () => null,
    complete: async (messages: { content: unknown }[]) => {
      asked.push(String(messages[0]?.content ?? ''));
      if (typeof reply !== 'string') reply();
      return reply;
    },
  } as unknown as SideCarClient & { asked: string[] };
}

function stateWithTask(task = 'Fix the off-by-one in FieldValidator13.') {
  const state = stubLoopState();
  state.messages.push({ role: 'user', content: task });
  return state;
}

describe('extractReplacement', () => {
  it('takes code out of a fenced reply', () => {
    expect(extractReplacement('```python\nreturn value < self.maximum\n```', REGION)).toBe(
      'return value < self.maximum',
    );
  });

  it('accepts a bare code reply', () => {
    expect(extractReplacement('return value < self.maximum', REGION)).toBe('return value < self.maximum');
  });

  it('rejects a reply identical to the region — that is the bug being fixed', () => {
    expect(extractReplacement(REGION, REGION)).toBeNull();
    expect(extractReplacement(`\`\`\`\n${REGION}\n\`\`\``, REGION)).toBeNull();
  });

  it('rejects prose', () => {
    // Handing an explanation back as if it were code would waste the model's
    // next turn and could be pasted into the file verbatim.
    for (const prose of [
      'Sure! Here is the fixed version:',
      "Here's the replacement code you need",
      'To fix this, change the comparison operator',
      'I would replace the return statement',
    ]) {
      expect(extractReplacement(prose, REGION), prose).toBeNull();
    }
  });

  it('rejects an empty reply', () => {
    expect(extractReplacement('', REGION)).toBeNull();
    expect(extractReplacement('   \n  ', REGION)).toBeNull();
  });
});

describe('buildAuthorPrompt', () => {
  it('carries the task, the path and the block, and asks for code only', () => {
    const [msg] = buildAuthorPrompt('Fix the bounds check.', 'src/validators.py', REGION);
    const text = String(msg.content);
    expect(text).toContain('Fix the bounds check.');
    expect(text).toContain('src/validators.py');
    expect(text).toContain(REGION);
    expect(text).toMatch(/ONLY the replacement code/);
    expect(text).toMatch(/must differ/i);
  });

  it('truncates a long task and a long block rather than sending everything', () => {
    // The whole hypothesis is that a NARROW frame is what makes this work; a
    // prompt that grows to the size of the agentic turn defeats the point.
    const [msg] = buildAuthorPrompt('x'.repeat(5000), 'a.py', 'y'.repeat(9000));
    const text = String(msg.content);
    expect(text.length).toBeLessThan(5000);
    expect(text).toContain('…');
  });
});

describe('isNoOpEdit', () => {
  // Detected from the CALL, not the error text: edit_file has at least two
  // wordings for this and a smoke run hit both, so a string match found half.
  const SAME = { path: 'a.py', search: REGION, replace: REGION };
  const DIFFERENT = { path: 'a.py', search: REGION, replace: 'return value < self.maximum' };

  it('fires on identical search/replace regardless of the error wording', () => {
    for (const msg of [
      IDENTICAL,
      "Error: edit_file did not apply this edit to a.py — 'search' and 'replace' are identical, so there is no change to make",
      'Error: edit_file failed AGAIN — you resubmitted the EXACT SAME search and replace.',
    ]) {
      expect(isNoOpEdit(use('1', SAME), err('1', msg)), msg.slice(0, 40)).toBe(true);
    }
  });

  it('does not fire on a real edit, a success, or another tool', () => {
    expect(isNoOpEdit(use('1', DIFFERENT), err('1', 'Error: search string not found.'))).toBe(false);
    expect(isNoOpEdit(use('1', SAME), ok('1'))).toBe(false);
    expect(isNoOpEdit(use('1', SAME), undefined)).toBe(false);
    expect(isNoOpEdit(use('1', SAME, 'write_file'), err('1'))).toBe(false);
  });

  it('fires when the result carries no is_error flag at all', () => {
    // The live shape. Every tool result reaching this hook had is_error
    // undefined, including failures, so requiring the flag rejected all 11
    // no-ops in a smoke run while the hook ran normally.
    const unflagged = {
      type: 'tool_result',
      tool_use_id: '1',
      content: 'Error: edit_file failed — search and replace text are identical; no change would be made.',
    } as ToolResultContentBlock;
    expect(unflagged.is_error).toBeUndefined();
    expect(isNoOpEdit(use('1', SAME), unflagged)).toBe(true);
  });

  it('ignores an empty search', () => {
    expect(isNoOpEdit(use('1', { path: 'a.py', search: '', replace: '' }), err('1'))).toBe(false);
  });
});

describe('applyScopedAuthor', () => {
  const original = process.env.SIDECAR_SCOPED_AUTHOR;
  beforeEach(() => {
    process.env.SIDECAR_SCOPED_AUTHOR = '1';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SIDECAR_SCOPED_AUTHOR;
    else process.env.SIDECAR_SCOPED_AUTHOR = original;
  });

  it('hands back a drafted replacement, and asks for the same search text', async () => {
    const state = stateWithTask();
    const client = stubClient('return value < self.maximum');
    const fired = await applyScopedAuthor(
      state,
      [use('1', { path: 'src/validators.py', search: REGION, replace: REGION })],
      [err('1')],
      client,
      stubCallbacks(),
    );

    expect(fired).toBe(true);
    const text = String((state.messages.at(-1)?.content as { text: string }[])[0].text);
    expect(text).toContain('return value < self.maximum');
    expect(text).toMatch(/SAME 'search'/);
    // The scoped call must be narrow: the task and the block, not the history.
    expect(client.asked).toHaveLength(1);
    expect(client.asked[0]).toContain(REGION);
  });

  it('stays off unless the flag is set', async () => {
    delete process.env.SIDECAR_SCOPED_AUTHOR;
    const state = stateWithTask();
    const client = stubClient('return value < self.maximum');
    const fired = await applyScopedAuthor(
      state,
      [use('1', { path: 'a.py', search: REGION, replace: REGION })],
      [err('1')],
      client,
      stubCallbacks(),
    );
    expect(fired).toBe(false);
    expect(client.asked).toHaveLength(0);
  });

  it('drafts once per file', async () => {
    const state = stateWithTask();
    const client = stubClient('return value < self.maximum');
    const call = [use('1', { path: 'a.py', search: REGION, replace: REGION })];
    expect(await applyScopedAuthor(state, call, [err('1')], client, stubCallbacks())).toBe(true);
    expect(await applyScopedAuthor(state, call, [err('1')], client, stubCallbacks())).toBe(false);
    expect(client.asked).toHaveLength(1);
  });

  it('injects nothing when the draft is unusable', async () => {
    const state = stateWithTask();
    const client = stubClient(REGION); // the model repeats the block
    const fired = await applyScopedAuthor(
      state,
      [use('1', { path: 'a.py', search: REGION, replace: REGION })],
      [err('1')],
      client,
      stubCallbacks(),
    );
    expect(fired).toBe(false);
    expect(state.messages).toHaveLength(1); // just the task
  });

  it('survives a failing side-call without costing the turn', async () => {
    const state = stateWithTask();
    const client = stubClient(() => {
      throw new Error('model unreachable');
    });
    const fired = await applyScopedAuthor(
      state,
      [use('1', { path: 'a.py', search: REGION, replace: REGION })],
      [err('1')],
      client,
      stubCallbacks(),
    );
    expect(fired).toBe(false);
  });

  it('ignores successful edits and other failures', async () => {
    const state = stateWithTask();
    const client = stubClient('something else');
    expect(
      await applyScopedAuthor(
        state,
        [use('1', { path: 'a.py', search: 'x', replace: 'y' })],
        [ok('1')],
        client,
        stubCallbacks(),
      ),
    ).toBe(false);
    expect(
      await applyScopedAuthor(
        state,
        [use('2', { path: 'a.py', search: 'x', replace: 'y' })],
        [err('2', 'Error: edit_file failed — search string not found in a.py.')],
        client,
        stubCallbacks(),
      ),
    ).toBe(false);
    expect(client.asked).toHaveLength(0);
  });
});
