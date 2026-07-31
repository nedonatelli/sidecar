import { describe, it, expect } from 'vitest';
import {
  isActionRequest,
  isMutationRequest,
  looksLikeDeferredAction,
  hasFakeToolOutput,
  maybeInjectActionReprompt,
} from './actionReprompt.js';
import { stubLoopState, stubCallbacks } from './testHelpers.js';

describe('isMutationRequest', () => {
  // The predicate that licenses fence-write coercion — synthesizing a write_file
  // from a code fence the model merely printed. It must be strictly narrower than
  // isActionRequest, which deliberately fires on reads so the re-prompt nudge can
  // tell a model to call read_file.
  //
  // Measured before this existed: "Read src/helpers.ts and tell me what it does."
  // classified as an action request, so a model that correctly answered "that file
  // does not exist" and illustrated a NEIGHBOURING file in a fence had that fence
  // written to src/helpers.ts. 3 of 5 trials, claude-sonnet-5.

  it('is false for a pure read request', () => {
    expect(isMutationRequest('Read src/helpers.ts and tell me what it does.')).toBe(false);
  });

  it.each([
    'show me src/utils.ts',
    'what does src/utils.ts do?',
    'look at src/config/settings.ts',
    'find the bug in src/utils.ts',
    'check src/utils.ts',
    'list the exports in src/index.ts',
    'search src/agent/tools.ts for the registry',
  ])('is false for read-only phrasing: %s', (text) => {
    expect(isMutationRequest(text)).toBe(false);
  });

  it.each([
    'write a helper in src/utils.ts',
    'create src/newfile.ts',
    'add a function to src/utils.ts',
    'fix the off-by-one in src/loop.ts',
    'edit src/utils.ts to return a number',
    'refactor src/agent/executor.ts',
    'implement the parser in src/parse.ts',
    'rename the function in src/utils.ts',
    'delete src/old.ts',
    'replace the body of src/utils.ts',
  ])('is true for mutating phrasing: %s', (text) => {
    expect(isMutationRequest(text)).toBe(true);
  });

  it('still requires a file path, like isActionRequest', () => {
    expect(isMutationRequest('write something for me')).toBe(false);
  });

  it('is never true where isActionRequest is false', () => {
    // Strictly narrower: coercion can only fire where the nudge would.
    for (const t of ['hello there', 'what is TypeScript?', 'read src/a.ts', 'thanks!']) {
      if (!isActionRequest(t)) expect(isMutationRequest(t)).toBe(false);
    }
  });
});

describe('isActionRequest', () => {
  it('stays true for a read request — the nudge must still fire', () => {
    // Narrowing this instead of adding a separate predicate would stop the loop
    // telling a model to call read_file when it answered a read request as prose.
    expect(isActionRequest('Read src/helpers.ts and tell me what it does.')).toBe(true);
  });

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

describe('hasFakeToolOutput', () => {
  it('detects a fabricated <tool_output> wrapper', () => {
    expect(hasFakeToolOutput('<tool_output tool="edit_file"> {"path": "a.py"} </tool_output>')).toBe(true);
  });

  it('detects a fabricated <tool_response> wrapper', () => {
    expect(hasFakeToolOutput('done!\n<tool_response>\nFile edited: a.py\n</tool_response>')).toBe(true);
  });

  it('does not match ordinary prose or code', () => {
    expect(hasFakeToolOutput('The tool output shows the file was edited.')).toBe(false);
    expect(hasFakeToolOutput('```python\nprint("hi")\n```')).toBe(false);
  });
});

describe('maybeInjectActionReprompt', () => {
  function makeState(userMessage: string, tools = true) {
    const state = stubLoopState({
      tools: tools ? ([{ name: 'read_file' }] as never) : [],
      messages: [{ role: 'user', content: userMessage }],
      // The code-as-text tests below assert the targeted wording; the flag is
      // read with `=== true` so states without it exercise the generic path.
      config: { codeAsTextRecoveryEnabled: true } as never,
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
    // '['-prefixed so lastUserMessageText skips it on the next firing check.
    expect(text.text.startsWith('[')).toBe(true);
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

  // -------------------------------------------------------------------------
  // Code-as-text shape (qwen2.5-coder:7b, lh-calculator-session, 2026-07-17).
  //
  // The live trajectory: the model printed the complete updated file in a
  // ```python fence ("Let's write this to calculator.py using the edit_file
  // tool"), got the generic reprompt, then emitted a FABRICATED
  // <tool_response><tool_output tool="edit_file"> block and terminated believing
  // the edit landed. Two defects: the generic wording never told it the printed
  // code wasn't saved, and the reprompt's own injection became "the last user
  // message" — matching neither trigger — so the second firing was disarmed at
  // the exact moment the model doubled down.
  // -------------------------------------------------------------------------

  it('uses the targeted code-as-text wording when the model printed the code in a fence', () => {
    const state = makeState('Create calculator.py with two fully-implemented functions: add and subtract.');
    const cb = stubCallbacks();
    const narrated =
      "Here is the updated content:\n```python\ndef add(a, b):\n  return a + b\n```\nLet's save the file.";
    expect(maybeInjectActionReprompt(state, narrated, cb)).toBe(true);
    const text = (state.messages[state.messages.length - 1].content as { text: string }[])[0].text;
    expect(text.startsWith('[')).toBe(true);
    expect(text).toContain('NOT saved');
    expect(text).toContain('write_file(path="calculator.py"');
  });

  it('calls out the fabricated <tool_output> when the model roleplays a tool result', () => {
    const state = makeState('Now add multiply and divide to calculator.py.');
    const cb = stubCallbacks();
    const fake =
      '<tool_response> <tool_output tool="edit_file"> {"path": "calculator.py"} </tool_output> </tool_response>';
    expect(maybeInjectActionReprompt(state, fake, cb)).toBe(true);
    const text = (state.messages[state.messages.length - 1].content as { text: string }[])[0].text;
    expect(text).toMatch(/fiction/);
    expect(text).toContain('write_file(path="calculator.py"');
  });

  it('fires a SECOND time on fake tool output with no intent phrasing — the first injection must not mask the user request', () => {
    const state = makeState('Now add multiply and divide to calculator.py.');
    const cb = stubCallbacks();
    expect(
      maybeInjectActionReprompt(state, 'Here is the code:\n```python\ndef multiply(a, b):\n  return a * b\n```', cb),
    ).toBe(true);
    // Second turn: pure fabricated output, no "I will…" phrasing. Before the
    // '['-prefix fix, lastUserMessageText returned the first injection here,
    // isActionRequest was false, and this did NOT fire.
    const fake = '<tool_output tool="edit_file"> {"path": "calculator.py", "search": ""} </tool_output>';
    expect(maybeInjectActionReprompt(state, fake, cb)).toBe(true);
    expect(state.actionRepromptCount).toBe(2);
  });

  it('keeps the generic wording when codeAsTextRecoveryEnabled is off (the A/B off-arm)', () => {
    const state = stubLoopState({
      tools: [{ name: 'write_file' }] as never,
      messages: [{ role: 'user', content: 'Create calculator.py with add and subtract functions.' }],
    });
    const cb = stubCallbacks();
    const narrated = 'Here is the file:\n```python\ndef add(a, b):\n  return a + b\n```';
    expect(maybeInjectActionReprompt(state, narrated, cb)).toBe(true);
    const text = (state.messages[state.messages.length - 1].content as { text: string }[])[0].text;
    expect(text).toMatch(/call the appropriate tools/i);
    expect(text).not.toContain('NOT saved');
  });

  it('a code fence on a plain question does not fire — code-as-text picks wording, not the trigger', () => {
    const state = makeState('how would a divide-by-zero guard look in Python?');
    const cb = stubCallbacks();
    const answer = '```python\ndef divide(a, b):\n  if b == 0:\n    raise ValueError()\n  return a / b\n```';
    expect(maybeInjectActionReprompt(state, answer, cb)).toBe(false);
  });

  it('falls back to a generic target when the user message names no file', () => {
    const state = stubLoopState({
      tools: [{ name: 'write_file' }] as never,
      messages: [{ role: 'user', content: 'implement the discount computation module' }],
      config: { codeAsTextRecoveryEnabled: true } as never,
    });
    const cb = stubCallbacks();
    const narrated = "I'll write the module:\n```python\ndef discount(p):\n  return p * 0.9\n```";
    expect(maybeInjectActionReprompt(state, narrated, cb)).toBe(true);
    const text = (state.messages[state.messages.length - 1].content as { text: string }[])[0].text;
    expect(text).toContain('path=<the file the task names>');
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
