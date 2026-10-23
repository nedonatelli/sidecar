import type { AgentCallbacks } from '../agent/loop.js';
import type { ExtensionMessage } from './chatWebview.js';

/**
 * Callbacks that stream an agent run into the chat panel from outside the
 * normal chat turn: the facet review offer, `sidecar.facets.dispatch`, and
 * auto mode.
 *
 * The webview's `assistantMessage` handler finalizes the message right away
 * when no run is loading. That is meant for one-shot notices ("✓ All changes
 * accepted"), so a notice never keeps a blinking caret. These callers streamed
 * every chunk as `assistantMessage` without ever entering the loading state, so
 * each chunk became its own finished message: the architecture review showed
 * up in the chat as one bubble per token. A normal chat turn posts
 * `setLoading: true` first (agentHandlers.ts); this does the same on the first
 * chunk of a stream, and again after each `done`, since auto mode posts one per
 * task.
 */
export function chatStreamCallbacks(
  post: (msg: ExtensionMessage) => void,
  opts: { postDoneOnDone?: boolean } = {},
): Pick<AgentCallbacks, 'onText' | 'onToolCall' | 'onToolResult' | 'onDone'> {
  let streaming = false;
  const ensureStreaming = () => {
    if (streaming) return;
    streaming = true;
    post({ command: 'setLoading', isLoading: true });
  };
  return {
    onText: (text) => {
      ensureStreaming();
      post({ command: 'assistantMessage', content: text });
    },
    onToolCall: (name, _input, id) => {
      ensureStreaming();
      post({ command: 'toolCall', toolName: name, toolCallId: id, content: name });
    },
    onToolResult: (name, result, _isError, id) => {
      post({ command: 'toolResult', toolName: name, toolCallId: id, content: result });
    },
    onDone: () => {
      if (!opts.postDoneOnDone) return;
      streaming = false;
      post({ command: 'done' });
    },
  };
}
