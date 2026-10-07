import { describe, it, expect } from 'vitest';
import { enrichAndPruneMessages } from './messageEnricher.js';
import type { ChatMessage } from '../../ollama/types.js';

// A message with an image is content BLOCKS. The enricher used to treat any
// non-string content as '' and write that back, so "what's wrong here?" plus a
// screenshot reached the model as an empty prompt, on every backend.

const config = { includeActiveFile: false, fetchUrlContext: false } as never;
const state = { activeFileIncluded: false } as never;
const enrich = (messages: ChatMessage[]) => enrichAndPruneMessages(messages, config, '', null, state, false);

const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };

describe('enrichAndPruneMessages', () => {
  it('keeps the image and the text of a message with an image', async () => {
    const messages = [
      { role: 'user', content: [image, { type: 'text', text: "what's wrong here?" }] },
    ] as unknown as ChatMessage[];
    await enrich(messages);
    const content = messages.at(-1)!.content as Array<{ type: string; text?: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((b) => b.type === 'image')).toBe(true);
    expect(content.find((b) => b.type === 'text')?.text).toBe("what's wrong here?");
  });

  it('keeps an image-only message as it is', async () => {
    const messages = [{ role: 'user', content: [image] }] as unknown as ChatMessage[];
    await enrich(messages);
    expect(messages.at(-1)!.content).toEqual([image]);
  });

  it('still enriches a plain-text message as a string', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello there' }];
    await enrich(messages);
    expect(messages.at(-1)!.content).toBe('hello there');
  });
});
