import { describe, it, expect } from 'vitest';
import { chatStreamCallbacks } from './chatStream.js';
import type { ExtensionMessage } from './chatWebview.js';

// The architecture review offer streamed its output as `assistantMessage`
// chunks without entering the loading state, and the webview finalizes an
// assistantMessage immediately when nothing is loading: the review appeared as
// one finished bubble per token.

function recorder() {
  const msgs: ExtensionMessage[] = [];
  return { msgs, post: (m: ExtensionMessage) => msgs.push(m) };
}

describe('chatStreamCallbacks', () => {
  it('enters the loading state once, before the first chunk, so chunks join one message', () => {
    const { msgs, post } = recorder();
    const cb = chatStreamCallbacks(post);
    cb.onText('The ');
    cb.onText('review');
    expect(msgs.map((m) => m.command)).toEqual(['setLoading', 'assistantMessage', 'assistantMessage']);
    expect(msgs[0]).toEqual({ command: 'setLoading', isLoading: true });
    expect(msgs.slice(1).map((m) => m.content)).toEqual(['The ', 'review']);
  });

  it('also enters it when a tool call comes first', () => {
    const { msgs, post } = recorder();
    const cb = chatStreamCallbacks(post);
    cb.onToolCall('architecture-reviewer:read_file', {}, 't1');
    cb.onText('x');
    expect(msgs.map((m) => m.command)).toEqual(['setLoading', 'toolCall', 'assistantMessage']);
  });

  it('leaves done to the caller by default (the facet paths post it in finally)', () => {
    const { msgs, post } = recorder();
    const cb = chatStreamCallbacks(post);
    cb.onText('x');
    cb.onDone?.();
    expect(msgs.map((m) => m.command)).toEqual(['setLoading', 'assistantMessage']);
  });

  it('with postDoneOnDone, posts done and re-enters loading for the next run (auto mode, one per task)', () => {
    const { msgs, post } = recorder();
    const cb = chatStreamCallbacks(post, { postDoneOnDone: true });
    cb.onText('task 1');
    cb.onDone?.();
    cb.onText('task 2');
    expect(msgs.map((m) => m.command)).toEqual([
      'setLoading',
      'assistantMessage',
      'done',
      'setLoading',
      'assistantMessage',
    ]);
  });
});
