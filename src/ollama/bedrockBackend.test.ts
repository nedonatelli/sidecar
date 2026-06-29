import { describe, it, expect, vi, afterEach } from 'vitest';
import { BedrockBackend } from './bedrockBackend.js';
import type { ChatMessage } from './types.js';

const CREDS = { accessKeyId: 'AKID', secretAccessKey: 'secret' };

// Build one AWS event-stream chunk frame wrapping an Anthropic event.
function chunkFrame(innerEvent: object): Buffer {
  function strHeader(name: string, value: string): Buffer {
    const n = Buffer.from(name);
    const v = Buffer.from(value);
    const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = 0;
    out.writeUInt8(n.length, o); o += 1;
    n.copy(out, o); o += n.length;
    out.writeUInt8(7, o); o += 1;
    out.writeUInt16BE(v.length, o); o += 2;
    v.copy(out, o);
    return out;
  }
  const headers = Buffer.concat([strHeader(':message-type', 'event'), strHeader(':event-type', 'chunk')]);
  const bytes = Buffer.from(JSON.stringify(innerEvent)).toString('base64');
  const payload = Buffer.from(JSON.stringify({ bytes }));
  const total = 12 + headers.length + payload.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headers.length, 4);
  headers.copy(out, 12);
  payload.copy(out, 12 + headers.length);
  return out;
}

function streamResponse(frames: Buffer[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new Uint8Array(f));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('BedrockBackend', () => {
  it('complete() signs the request, omits `model` from the body, and returns the text', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
    });

    const backend = new BedrockBackend('us-west-2', { credentials: CREDS });
    const text = await backend.complete('anthropic.claude-3-5-sonnet-20241022-v2:0', 'sys', messages, 64);

    expect(text).toBe('pong');
    expect(captured!.url).toContain('bedrock-runtime.us-west-2.amazonaws.com');
    expect(captured!.url).toContain('/invoke');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    const body = JSON.parse(captured!.init.body as string);
    expect(body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(body.model).toBeUndefined(); // model goes in the URL, not the body
    expect(body.system).toBe('sys');
  });

  it('uses Bearer auth (a Bedrock API key) instead of SigV4 when a token is set, encoding the model path', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    });

    const backend = new BedrockBackend('us-east-1', { bearerToken: 'BEDROCK-API-KEY-123' });
    await backend.complete('us.anthropic.claude-sonnet-4-20250514-v1:0', 'sys', messages, 32);

    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer BEDROCK-API-KEY-123');
    expect(headers.Authorization).not.toMatch(/AWS4-HMAC-SHA256/);
    // model id colon is percent-encoded in the URL, same as the signed path
    expect(captured!.url).toContain('/model/us.anthropic.claude-sonnet-4-20250514-v1%3A0/invoke');
  });

  it('placeholder apiKey "ollama" is ignored (falls through to SigV4)', async () => {
    let captured: { init: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = { init };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    });
    const backend = new BedrockBackend('us-east-1', { bearerToken: 'ollama', credentials: CREDS });
    await backend.complete('m', 'sys', messages, 16);
    expect((captured!.init.headers as Record<string, string>).Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('streamChat() decodes event-stream frames into StreamEvents', async () => {
    vi.stubGlobal('fetch', async () =>
      streamResponse([
        chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }),
        chunkFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }),
        chunkFrame({ type: 'message_stop' }),
      ]),
    );

    const backend = new BedrockBackend('us-east-1', { credentials: CREDS });
    const events = [];
    for await (const ev of backend.streamChat('us.anthropic.claude-sonnet-4-20250514-v1:0', 'sys', messages)) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', text: 'Hello' });
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });
});
