import type { AnthropicStreamEvent, StreamEvent, ToolUseContentBlock } from './types.js';

// Translate Anthropic Messages streaming events into SideCar `StreamEvent`s.
// Shared by the Anthropic backend (events arrive over SSE) and the Bedrock
// backend (the same events arrive base64-wrapped in AWS event-stream frames),
// so both paths produce identical text / thinking / tool_use / stop / usage
// output. The generator holds all per-stream state (partial tool-use JSON,
// thinking flag, token accumulators) as locals.
export async function* translateAnthropicStream(
  events: AsyncIterable<AnthropicStreamEvent>,
  model: string,
): AsyncGenerator<StreamEvent> {
  let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
  let currentThinking = false;
  let accInputTokens = 0;
  let accOutputTokens = 0;
  let accCacheCreate = 0;
  let accCacheRead = 0;
  let sawMessageStop = false;

  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        if (event.message?.usage) {
          accInputTokens += event.message.usage.input_tokens ?? 0;
          accOutputTokens += event.message.usage.output_tokens ?? 0;
          accCacheCreate += event.message.usage.cache_creation_input_tokens ?? 0;
          accCacheRead += event.message.usage.cache_read_input_tokens ?? 0;
        }
        break;

      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          currentToolUse = { id: event.content_block.id || '', name: event.content_block.name || '', inputJson: '' };
        } else if (event.content_block?.type === 'thinking') {
          currentThinking = true;
        }
        break;

      case 'content_block_delta':
        if (!event.delta) break;
        if (event.delta.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', text: event.delta.text };
        } else if (event.delta.type === 'thinking_delta' && event.delta.thinking && currentThinking) {
          yield { type: 'thinking', thinking: event.delta.thinking };
        } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json && currentToolUse) {
          currentToolUse.inputJson += event.delta.partial_json;
        }
        break;

      case 'content_block_stop':
        currentThinking = false;
        if (currentToolUse) {
          let input: Record<string, unknown> = {};
          let malformedRaw: string | undefined;
          try {
            input = JSON.parse(currentToolUse.inputJson || '{}');
          } catch {
            malformedRaw = currentToolUse.inputJson;
          }
          const toolUse: ToolUseContentBlock = {
            type: 'tool_use',
            id: currentToolUse.id,
            name: currentToolUse.name,
            input,
            ...(malformedRaw !== undefined ? { _malformedInputRaw: malformedRaw } : {}),
          };
          yield { type: 'tool_use', toolUse };
          currentToolUse = null;
        }
        break;

      case 'message_delta':
        if (event.usage) {
          accOutputTokens = event.usage.output_tokens ?? accOutputTokens;
        }
        if (event.delta?.stop_reason) {
          yield { type: 'stop', stopReason: event.delta.stop_reason };
        }
        break;

      case 'message_stop':
        sawMessageStop = true;
        yield {
          type: 'usage',
          model,
          usage: {
            inputTokens: accInputTokens,
            outputTokens: accOutputTokens,
            cacheCreationInputTokens: accCacheCreate,
            cacheReadInputTokens: accCacheRead,
          },
        };
        break;

      case 'error':
        if (event.error) throw new Error(event.error.message);
        break;

      case 'ping':
        // Keep-alive; carries nothing.
        break;
    }
  }

  // The stream ended without `message_stop` -- the connection dropped or the
  // body was cut. Say so instead of letting the turn read as a clean finish:
  // the loop withholds any tool call from a turn that stopped with 'error'
  // (#164 ML-15), as it already does for an Ollama stream with no done chunk.
  if (!sawMessageStop) {
    yield { type: 'warning', message: 'The response stream ended before it finished — the response may be truncated.' };
    yield { type: 'stop', stopReason: 'error' };
  }
}
