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

  it('matches the "I will start by reading the core files" planning stall', () => {
    expect(looksLikeDeferredAction('I will start by reading the core files in src/agent.')).toBe(true);
  });

  it('matches "I\'ll first map out the system"', () => {
    expect(looksLikeDeferredAction("I'll first map out the system before forming judgments.")).toBe(true);
  });

  it('matches "I\'m going to investigate the core components"', () => {
    expect(looksLikeDeferredAction('I am going to investigate the core components responsible for scheduling.')).toBe(
      true,
    );
  });

  it('does not match a plain explanation with no announced intent', () => {
    expect(looksLikeDeferredAction('The jq command failed because the path was wrong.')).toBe(false);
  });

  it('does not match a completed action report', () => {
    expect(looksLikeDeferredAction('The file has been updated successfully.')).toBe(false);
  });

  it('does not match a recommendation that is not self-intent', () => {
    expect(looksLikeDeferredAction('I recommend reading the documentation for the retry policy.')).toBe(false);
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

  // -------------------------------------------------------------------------
  // Content-block extraction.
  //
  // Every test below used to give the user message a plain STRING `content`, so
  // the array-of-blocks branch — filter → map → join — was never executed. Stryker
  // proved it: `.filter(() => false)`, which discards every block, SURVIVED. The
  // path is dead in the tests and live in production, where the webview sends
  // block arrays (attachments, images) and gate injections push
  // `content: [{type:'text'}]`.
  //
  // That is exactly how the guard died the first time — extraction yielded '',
  // `isActionRequest('')` returned false, and the reprompt silently never fired.
  // These tests make the extraction load-bearing.
  // -------------------------------------------------------------------------

  it('reads an action request out of a user message made of content BLOCKS, not a string', () => {
    const state = stubLoopState({
      tools: [{ name: 'edit_file' }] as never,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'edit src/foo.ts to add a hello function' }] },
      ] as never,
    });
    const cb = stubCallbacks();
    expect(maybeInjectActionReprompt(state, 'Here is what I would write...', cb)).toBe(true);
  });

  it('extracts only the TEXT blocks — an image alongside the text must not swallow it', () => {
    const state = stubLoopState({
      tools: [{ name: 'edit_file' }] as never,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
            { type: 'text', text: 'edit src/foo.ts to add a hello function' },
          ],
        },
      ] as never,
    });
    const cb = stubCallbacks();
    expect(maybeInjectActionReprompt(state, 'Here is what I would write...', cb)).toBe(true);
  });

  it('skips a user message whose text is only WHITESPACE — it carries no intent either', () => {
    // Stryker: `raw.trim() === ''` → `raw === ''` survived. With that mutation a
    // blank-but-not-empty message is returned AS the user's intent, and the real
    // request behind it is never seen — the same shape as the tool-result bug.
    const state = stubLoopState({
      tools: [{ name: 'edit_file' }] as never,
      messages: [
        { role: 'user', content: 'edit src/foo.ts to add a hello function' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: '   \n  ' }] },
      ] as never,
    });
    const cb = stubCallbacks();
    expect(maybeInjectActionReprompt(state, 'Here is the code you asked for...', cb)).toBe(true);
  });

  it('injects a well-formed user turn that actually tells the model to call tools', () => {
    // Stryker: `role: 'user'` → `role: ""` survived, as did emptying the injected
    // text. Nothing asserted what we push into the conversation — and a malformed
    // role is rejected by the API at runtime, where it is expensive to discover.
    const state = makeState('edit src/foo.ts to add a hello function');
    const cb = stubCallbacks();
    expect(maybeInjectActionReprompt(state, 'I would add a function like this...', cb)).toBe(true);

    const injected = state.messages[state.messages.length - 1];
    expect(injected.role).toBe('user');
    const text = (injected.content as { type: string; text: string }[])[0];
    expect(text.type).toBe('text');
    expect(text.text).toMatch(/text only/i);
    expect(text.text).toMatch(/call the appropriate tools/i);
  });

  it('does not fire when there is no user message at all', () => {
    // The `return ''` fallback — reported by Stryker as NoCoverage, i.e. no test
    // ever reached it.
    const state = stubLoopState({
      tools: [{ name: 'edit_file' }] as never,
      messages: [{ role: 'assistant', content: 'thinking out loud' }] as never,
    });
    const cb = stubCallbacks();
    expect(maybeInjectActionReprompt(state, 'Some prose with no intent opener.', cb)).toBe(false);
  });

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

  it('still fires after a tool call — a tool result is not the user speaking', () => {
    // The live failure this guards. Tool results are role:'user' messages whose
    // blocks are all tool_result, so filtering to text blocks yields ''. That ''
    // was returned as "the user's message", and isActionRequest('') is false —
    // so the reprompt was dead on every turn after the first tool call, which is
    // precisely when a model narrates instead of editing.
    //
    // Observed: qwen2.5-coder read greeter.ts, printed the finished JSDoc in a
    // fenced code block, and the loop accepted that as done. The file was never
    // touched.
    const state = stubLoopState({
      tools: [{ name: 'edit_file' }] as never,
      messages: [
        { role: 'user', content: 'Add a JSDoc comment above the welcome function in src/greeter.ts.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/greeter.ts' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function welcome(name: string) {}' }],
        },
      ] as never,
    });
    const cb = stubCallbacks();

    // The model answers with the finished code as prose. It must be sent back to work.
    const narrated = '```typescript\n/** Greets someone. */\nexport function welcome(name: string) {}\n```';
    expect(maybeInjectActionReprompt(state, narrated, cb)).toBe(true);
    expect(state.actionRepromptCount).toBe(1);
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
