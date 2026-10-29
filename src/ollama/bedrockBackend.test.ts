import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { BedrockBackend, bedrockRuntimeOrigin, bedrockControlOrigin, bedrockErrorMessage } from './bedrockBackend.js';
import type { ChatMessage } from './types.js';
import { workspace } from 'vscode';
import { invalidateConfigCache } from '../config/settings.js';

const CREDS = { accessKeyId: 'AKID', secretAccessKey: 'secret' };

describe('bedrock endpoint helpers', () => {
  it('derives the standard runtime + control hosts per region', () => {
    expect(bedrockRuntimeOrigin('us-east-1')).toBe('https://bedrock-runtime.us-east-1.amazonaws.com');
    expect(bedrockRuntimeOrigin('eu-central-1')).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com');
    expect(bedrockControlOrigin('us-west-2')).toBe('https://bedrock.us-west-2.amazonaws.com');
  });

  it('derives the FIPS hosts (required for GovCloud)', () => {
    expect(bedrockRuntimeOrigin('us-gov-east-1', true)).toBe(
      'https://bedrock-runtime-fips.us-gov-east-1.amazonaws.com',
    );
    expect(bedrockRuntimeOrigin('us-gov-west-1', true)).toBe(
      'https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com',
    );
    expect(bedrockControlOrigin('us-gov-west-1', true)).toBe('https://bedrock-fips.us-gov-west-1.amazonaws.com');
  });

  it('refuses a region that would change the host the credentials go to', () => {
    for (const region of ['evil.example/x', 'x@evil.example', 'us-east-1.evil.example', 'evil.example:443#', '']) {
      expect(() => bedrockRuntimeOrigin(region)).toThrow(/Invalid Bedrock region/);
      expect(() => bedrockControlOrigin(region)).toThrow(/Invalid Bedrock region/);
    }
  });
});

// Build one AWS event-stream chunk frame wrapping an Anthropic event.
function chunkFrame(innerEvent: object): Buffer {
  function strHeader(name: string, value: string): Buffer {
    const n = Buffer.from(name);
    const v = Buffer.from(value);
    const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = 0;
    out.writeUInt8(n.length, o);
    o += 1;
    n.copy(out, o);
    o += n.length;
    out.writeUInt8(7, o);
    o += 1;
    out.writeUInt16BE(v.length, o);
    o += 2;
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

// The bearer token wins over SigV4 when AWS_BEARER_TOKEN_BEDROCK is set, so a
// developer's real token in the environment turned the SigV4 tests into bearer
// requests. Every test starts without it; a test that wants it stubs it.
beforeEach(() => vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', ''));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('BedrockBackend', () => {
  it('complete() signs the request, omits `model` from the body, and returns the text', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 5, output_tokens: 1 } }),
        { status: 200 },
      );
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

  it('routes to the FIPS host when constructed with useFips (GovCloud)', async () => {
    let captured: { url: string } | null = null;
    vi.stubGlobal('fetch', async (url: string) => {
      captured = { url };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    });

    const backend = new BedrockBackend('us-gov-west-1', { credentials: CREDS }, undefined, true);
    await backend.complete('anthropic.claude-3-5-sonnet-20241022-v2:0', 'sys', messages, 32);

    expect(captured!.url).toContain('bedrock-runtime-fips.us-gov-west-1.amazonaws.com');
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

describe('listAnthropicModels — inference-profile pagination', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows nextToken across pages and keeps only Anthropic ids', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.includes('/inference-profiles')) {
        if (!url.includes('nextToken')) {
          return new Response(
            JSON.stringify({
              inferenceProfileSummaries: [
                { inferenceProfileId: 'us.meta.llama3-2-90b-instruct-v1:0' },
                { inferenceProfileId: 'us.anthropic.claude-sonnet-4-6-v1:0' },
              ],
              nextToken: 'PAGE2',
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            inferenceProfileSummaries: [{ inferenceProfileId: 'us.anthropic.claude-fable-5-v1:0' }],
          }),
          { status: 200 },
        );
      }
      // foundation-models
      return new Response(
        JSON.stringify({
          modelSummaries: [
            {
              modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
              providerName: 'Anthropic',
              inferenceTypesSupported: ['ON_DEMAND'],
              outputModalities: ['TEXT'],
            },
          ],
        }),
        { status: 200 },
      );
    });

    const backend = new BedrockBackend('us-east-1', { credentials: CREDS });
    const models = await backend.listAnthropicModels();

    expect(models).toEqual([
      'anthropic.claude-3-haiku-20240307-v1:0',
      'us.anthropic.claude-fable-5-v1:0',
      'us.anthropic.claude-sonnet-4-6-v1:0',
    ]);
    // Page 2 requested with the token; both pages carried maxResults.
    const profileCalls = calls.filter((u) => u.includes('/inference-profiles'));
    expect(profileCalls).toHaveLength(2);
    expect(profileCalls[0]).toContain('maxResults=1000');
    expect(profileCalls[1]).toContain('nextToken=PAGE2');
  });

  it('stops cleanly when the first page has no nextToken', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/inference-profiles')) {
        return new Response(
          JSON.stringify({
            inferenceProfileSummaries: [{ inferenceProfileId: 'eu.anthropic.claude-opus-4-8-v1:0' }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ modelSummaries: [] }), { status: 200 });
    });
    const backend = new BedrockBackend('eu-central-1', { credentials: CREDS });
    expect(await backend.listAnthropicModels()).toEqual(['eu.anthropic.claude-opus-4-8-v1:0']);
  });
});

// Shapes from the us-east-1 control plane, 2026-10-23: a retired model's
// inference profile is still listed as ACTIVE, while its base model is gone from
// ListFoundationModels. Invoking it returned 404 "end of its life".
describe('listAnthropicModels — retired models (live us-east-1 shapes)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const arn = (id: string) => `arn:aws:bedrock:us-east-1::foundation-model/${id}`;
  const profile = (id: string, base: string) => ({
    inferenceProfileId: id,
    status: 'ACTIVE',
    models: [{ modelArn: arn(base) }],
  });
  const fmodel = (id: string, lifecycle: Record<string, unknown>) => ({
    modelId: id,
    providerName: 'Anthropic',
    inferenceTypesSupported: ['INFERENCE_PROFILE'],
    outputModalities: ['TEXT'],
    modelLifecycle: lifecycle,
  });

  function stub(profiles: unknown[], foundation: unknown[] | null) {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/inference-profiles')) {
        return new Response(JSON.stringify({ inferenceProfileSummaries: profiles }), { status: 200 });
      }
      return foundation === null
        ? new Response('{"message":"AccessDenied"}', { status: 403 })
        : new Response(JSON.stringify({ modelSummaries: foundation }), { status: 200 });
    });
  }

  const PROFILES = [
    profile('us.anthropic.claude-3-haiku-20240307-v1:0', 'anthropic.claude-3-haiku-20240307-v1:0'),
    profile('us.anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic.claude-haiku-4-5-20251001-v1:0'),
    profile('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-sonnet-4-5-20250929-v1:0'),
  ];

  it('drops a profile whose base model is no longer listed, and keeps LEGACY models until their end of life', async () => {
    stub(PROFILES, [
      fmodel('anthropic.claude-haiku-4-5-20251001-v1:0', { status: 'ACTIVE', endOfLifeTime: null }),
      fmodel('anthropic.claude-sonnet-4-5-20250929-v1:0', { status: 'LEGACY', endOfLifeTime: '2027-04-08T08:00:00Z' }),
    ]);
    const models = await new BedrockBackend('us-east-1', { credentials: CREDS }).listAnthropicModels(
      undefined,
      new Date('2026-10-23T12:00:00Z'),
    );
    expect(models).toEqual([
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    ]);
  });

  it('drops a model once its end-of-life time has passed', async () => {
    stub(PROFILES.slice(2), [
      fmodel('anthropic.claude-sonnet-4-5-20250929-v1:0', { status: 'LEGACY', endOfLifeTime: '2027-04-08T08:00:00Z' }),
    ]);
    const after = await new BedrockBackend('us-east-1', { credentials: CREDS }).listAnthropicModels(
      undefined,
      new Date('2027-05-01T00:00:00Z'),
    );
    expect(after).toEqual([]);
  });

  it('filters nothing when the foundation-model list cannot be read (a key scoped to invoke only)', async () => {
    stub(PROFILES, null);
    const models = await new BedrockBackend('us-east-1', { credentials: CREDS }).listAnthropicModels();
    expect(models).toHaveLength(3);
  });
});

describe('bedrockErrorMessage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says a retired model is retired, keeping the AWS message', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          '{"message":"This model version has reached the end of its life. Please refer to the AWS documentation for more details."}',
          {
            status: 404,
            statusText: 'Not Found',
          },
        ),
    );
    const err = await new BedrockBackend('us-east-1', { credentials: CREDS })
      .complete('us.anthropic.claude-3-haiku-20240307-v1:0', 'sys', messages, 16)
      .catch((e: Error) => e.message);
    expect(err).toContain('404 Not Found — {"message":"This model version has reached the end of its life');
    expect(err).toContain('"us.anthropic.claude-3-haiku-20240307-v1:0" is retired on Bedrock');
  });

  it('says an account-level block is an AWS account setting, naming the region', () => {
    const msg = bedrockErrorMessage(
      400,
      'Bad Request',
      '{"message":"Error 002: Access to Bedrock models is not allowed for this account"}',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'us-east-1',
    );
    expect(msg).toContain('Error 002');
    expect(msg).toContain('does not let this account invoke Bedrock models in us-east-1');
    expect(msg).toContain('not a SideCar or key problem');
  });

  it('leaves other errors as they were', () => {
    expect(bedrockErrorMessage(429, 'Too Many Requests', 'slow down', 'm', 'us-east-1')).toBe(
      'Bedrock request failed: 429 Too Many Requests — slow down',
    );
  });
});

describe('BedrockBackend request body (#363)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    invalidateConfigCache();
  });

  it('caps max_tokens with maxOutputTokens and sends temperature to a prefixed Claude 3 id', async () => {
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: (key: string) => (key === 'maxOutputTokens' ? 4096 : key === 'agentMaxTokens' ? 200_000 : undefined),
      inspect: () => undefined,
    } as never);
    invalidateConfigCache();
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return streamResponse([chunkFrame({ type: 'message_stop' })]);
    });
    const backend = new BedrockBackend('us-east-1', { credentials: CREDS });
    for await (const _ of backend.streamChat('us.anthropic.claude-3-5-haiku-20241022-v1:0', 'sys', messages)) {
      void _;
    }
    expect(body.max_tokens).toBe(4096);
    expect(body).toHaveProperty('temperature');
  });
});
