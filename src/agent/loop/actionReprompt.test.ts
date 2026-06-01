import { describe, it, expect } from 'vitest';
import { isActionRequest, maybeInjectActionReprompt } from './actionReprompt.js';
import { stubLoopState, stubCallbacks } from './testHelpers.js';

describe('isActionRequest', () => {
  it('returns true for "edit src/foo.ts to add a function"', () => {
    expect(isActionRequest('edit src/foo.ts to add a function')).toBe(true);
  });

  it('returns true for "read src/agent/completionGate.ts and extend the regex"', () => {
    expect(isActionRequest('read src/agent/completionGate.ts and extend the regex')).toBe(true);
  });

  it('returns true for "fix the bug in utils.py"', () => {
    expect(isActionRequest('fix the bug in utils.py')).toBe(true);
  });

  it('returns true for "run tests/auth.test.ts and fix any failures"', () => {
    expect(isActionRequest('run tests/auth.test.ts and fix any failures')).toBe(true);
  });

  it('returns false for a plain question about code', () => {
    expect(isActionRequest('what does the authentication module do?')).toBe(false);
  });

  it('returns false for a conversational message with no file path', () => {
    expect(isActionRequest('can you explain how promises work?')).toBe(false);
  });

  it('returns false for a message with a file path but no action verb', () => {
    expect(isActionRequest('what is src/utils.ts?')).toBe(false);
  });
});

describe('maybeInjectActionReprompt', () => {
  function makeState(userMessage: string, tools = true) {
    const state = stubLoopState({
      tools: tools ? ([{ name: 'read_file' }] as never) : [],
      messages: [{ role: 'user', content: userMessage }],
    });
    return state;
  }

  it('injects a reprompt when model produces text on an action request', () => {
    const state = makeState('edit src/foo.ts to add a hello function');
    const cb = stubCallbacks();
    const result = maybeInjectActionReprompt(state, 'I would add a function like this...', cb);
    expect(result).toBe(true);
    expect(state.actionRepromptCount).toBe(1);
    const injected = state.messages[state.messages.length - 1];
    expect(
      typeof injected.content === 'string' ? injected.content : (injected.content as { text: string }[])[0].text,
    ).toContain('text only');
  });

  it('does not fire twice on the same run', () => {
    const state = makeState('edit src/foo.ts to add something');
    const cb = stubCallbacks();
    maybeInjectActionReprompt(state, 'I would...', cb);
    const result = maybeInjectActionReprompt(state, 'I would still...', cb);
    expect(result).toBe(false);
    expect(state.actionRepromptCount).toBe(1);
  });

  it('does not fire when no tools are available', () => {
    const state = makeState('edit src/foo.ts', false);
    const cb = stubCallbacks();
    expect(maybeInjectActionReprompt(state, 'I would...', cb)).toBe(false);
  });

  it('does not fire when the user message is a question (not an action request)', () => {
    const state = makeState('what does the authentication module do?');
    const cb = stubCallbacks();
    expect(maybeInjectActionReprompt(state, 'The auth module handles...', cb)).toBe(false);
  });

  it('does not fire when fullText is empty (no text at all)', () => {
    const state = makeState('edit src/foo.ts');
    const cb = stubCallbacks();
    expect(maybeInjectActionReprompt(state, '', cb)).toBe(false);
  });

  it('skips synthetic gate messages when finding the last user message', () => {
    // A gate injection starts with '[' and should be skipped so we look
    // at the real user message before it.
    const state = stubLoopState({
      tools: [{ name: 'edit_file' }] as never,
      messages: [
        { role: 'user', content: 'edit src/gate.ts to add pylint support' },
        { role: 'assistant', content: 'I will edit the file.' },
        {
          role: 'user',
          content: '[Completion gate — attempt 1 of 2]\n\nLint has not run...',
        },
      ],
    });
    const cb = stubCallbacks();
    // Should still fire because the real user message IS an action request.
    expect(maybeInjectActionReprompt(state, 'I would add pylint to the regex...', cb)).toBe(true);
  });
});
