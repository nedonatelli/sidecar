import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { runAgentLoop, type AgentCallbacks } from '../loop.js';
import { SideCarClient } from '../../ollama/client.js';

// End to end through the real Ollama client: a local server speaking Ollama's
// /api/chat stream. Its first answer is the stream error Ollama sends when it
// cannot parse a tool call the model wrote -- the exact text the smoke eval
// hit (fix-simple-bug, ministral-3), which used to end the whole run. The unit
// tests in loop.test.ts throw from a mocked streamChat; this proves the error
// as Ollama actually sends it reaches the retry, and the retry reaches Ollama.

const chatBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/chat') {
        chatBodies.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        if (chatBodies.length === 1) {
          res.end(JSON.stringify({ error: "invalid character '(' in string escape code" }) + '\n');
          return;
        }
        const msg = (content: string, done: boolean) =>
          JSON.stringify({ model: 'm', message: { role: 'assistant', content }, done }) + '\n';
        res.write(msg('Recovered after the re-ask.', false));
        res.end(
          JSON.stringify({ model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) +
            '\n',
        );
        return;
      }
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'm', model: 'm' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('Ollama tool-call parse error, end to end', () => {
  it('re-asks through the real client and finishes the run', async () => {
    const settings = await import('../../config/settings.js');
    const real = settings.getConfig();
    vi.spyOn(settings, 'getConfig').mockReturnValue({
      ...real,
      requestTimeout: 30,
      agentMaxIterations: 5,
      autoFixOnFailure: false,
    });

    const texts: string[] = [];
    const callbacks: AgentCallbacks = {
      onText: (t) => texts.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      onDone: () => {},
    };
    // Provider named explicitly: the URL rules would call a non-:11434 port OpenAI.
    const client = new SideCarClient('m', baseUrl, undefined, 'ollama');

    await runAgentLoop(client, [{ role: 'user', content: 'fix the bug' }], callbacks, new AbortController().signal);

    expect(chatBodies.length).toBe(2);
    expect(texts.join('')).toContain('Recovered after the re-ask.');
    const resent = JSON.stringify(chatBodies[1].messages);
    expect(resent).toContain('Tool call not parsed');
    expect(resent).toContain('string escape code');
    vi.restoreAllMocks();
  }, 30_000);
});
