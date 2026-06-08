import { describe, it, expect } from 'vitest';
import { isActionRequest, looksLikeDeferredAction, maybeInjectActionReprompt } from './actionReprompt.js';
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

describe('looksLikeDeferredAction', () => {
  it('matches "I will now attempt to find the TypeScript version"', () => {
    expect(
      looksLikeDeferredAction('I will now attempt to find the TypeScript version again by reading package.json'),
    ).toBe(true);
  });

  it('matches "I\'ll now read the file"', () => {
    expect(looksLikeDeferredAction("I'll now read the file to check the exports.")).toBe(true);
  });

  it('matches "Let me try again"', () => {
    expect(looksLikeDeferredAction('Let me try again with the correct path.')).toBe(true);
  });

  it('matches "I will add a comment to clarify Rule 9"', () => {
    expect(looksLikeDeferredAction('I will add a comment to clarify Rule 9 in the context of the case.')).toBe(true);
  });

  it('matches "Let me add the comment now"', () => {
    expect(looksLikeDeferredAction('Let me add the comment now.')).toBe(true);
  });

  it('matches "I will implement this addition"', () => {
    expect(looksLikeDeferredAction('I will implement this addition in basePrompt.ts.')).toBe(true);
  });

  it('matches "Would you like me to implement this?"', () => {
    expect(looksLikeDeferredAction('Would you like me to implement this addition in basePrompt.ts?')).toBe(true);
  });

  it('matches "Shall I add the example?"', () => {
    expect(looksLikeDeferredAction('Shall I add the example to the rules section?')).toBe(true);
  });

  it('matches "Do you want me to apply this?"', () => {
    expect(looksLikeDeferredAction('Do you want me to apply this change now?')).toBe(true);
  });

  it('does not match a plain explanation with no announced intent', () => {
    expect(looksLikeDeferredAction('The jq command failed because the path was wrong.')).toBe(false);
  });

  it('does not match a completed action report', () => {
    expect(looksLikeDeferredAction('The file has been updated successfully.')).toBe(false);
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

  it('fires up to MAX_ACTION_REPROMPTS (2) times on the same run', () => {
    const state = makeState('edit src/foo.ts to add something');
    const cb = stubCallbacks();
    // First: user message is an action request
    expect(maybeInjectActionReprompt(state, 'I would add a function...', cb)).toBe(true);
    // Second: model again announces deferred intent
    expect(maybeInjectActionReprompt(state, 'I will now try to edit the file.', cb)).toBe(true);
    // Third: capped
    const result = maybeInjectActionReprompt(state, 'I will now try again.', cb);
    expect(result).toBe(false);
    expect(state.actionRepromptCount).toBe(2);
  });

  it('does not fire when no tools are available', () => {
    const state = makeState('edit src/foo.ts', false);
    const cb = stubCallbacks();
    expect(maybeInjectActionReprompt(state, 'I would...', cb)).toBe(false);
  });

  it('fires when model text announces deferred intent even if user message is a question', () => {
    // e.g. gemma4:e4b: user asked "check the TypeScript version", model said
    // "I will now attempt to find it by reading package.json" but called no tool.
    const state = makeState('what is the TypeScript version in package.json?');
    const cb = stubCallbacks();
    const result = maybeInjectActionReprompt(
      state,
      'I will now attempt to find the TypeScript version again by reading the package.json file.',
      cb,
    );
    expect(result).toBe(true);
  });

  it('does not fire when the user message is a question and model text has no deferred intent', () => {
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
