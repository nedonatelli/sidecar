import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';

// DNS is faked: each test says what a name resolves to. The server is real,
// on 127.0.0.1, so a request that reaches it proves which address the
// connection actually used.
const dnsAnswers = vi.hoisted(() => new Map<string, string>());
vi.mock('dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dns')>();
  const lookup = (
    hostname: string,
    _opts: unknown,
    cb: (err: Error | null, addrs?: Array<{ address: string; family: number }>) => void,
  ) => {
    const address = dnsAnswers.get(hostname);
    if (!address) return cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    cb(null, [{ address, family: 4 }]);
  };
  return { ...actual, default: { ...actual, lookup }, lookup };
});

import { fetchGuarded, BlockedUrlError } from './netGuard.js';

let server: http.Server;
let port: number;
let hits: string[];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    if (req.url === '/to-rebinding-name') {
      res.writeHead(302, { location: `http://meta.attacker.example:${port}/secret` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('LOCAL SECRET');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  hits = [];
  dnsAnswers.clear();
});

describe('fetchGuarded checks the address the connection uses', () => {
  // A rebinding name answers a separate pre-check with a public address and
  // the connection with a private one. Here the connection's lookup is the
  // only lookup, and it says loopback.
  it('refuses a public-looking name that resolves to loopback at connect time', async () => {
    dnsAnswers.set('rebind.attacker.example', '127.0.0.1');
    await expect(fetchGuarded(`http://rebind.attacker.example:${port}/`)).rejects.toBeInstanceOf(BlockedUrlError);
    expect(hits).toEqual([]);
  });

  it('connects to a loopback name the caller allows (a local dev server)', async () => {
    dnsAnswers.set('dev.local.test', '127.0.0.1');
    const res = await fetchGuarded(`http://dev.local.test:${port}/`, { allowedHosts: ['dev.local.test'] });
    expect(res.body.toString()).toBe('LOCAL SECRET');
  });

  it('refuses IP literals in blocked ranges without connecting', async () => {
    await expect(fetchGuarded(`http://127.0.0.2:${port}/`)).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(fetchGuarded('http://[::ffff:a9fe:a9fe]/')).rejects.toBeInstanceOf(BlockedUrlError);
    expect(hits).toEqual([]);
  });

  it('checks every redirect hop: a redirect to the metadata address is refused', async () => {
    await expect(fetchGuarded(`http://127.0.0.1:${port}/to-metadata`, { allowedHosts: ['127.0.0.1'] })).rejects.toThrow(
      /link-local/,
    );
    expect(hits).toEqual(['/to-metadata']);
  });

  it('checks every redirect hop: a redirect to a name that resolves privately is refused', async () => {
    dnsAnswers.set('meta.attacker.example', '127.0.0.1');
    await expect(
      fetchGuarded(`http://127.0.0.1:${port}/to-rebinding-name`, { allowedHosts: ['127.0.0.1'] }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(hits).toEqual(['/to-rebinding-name']);
  });

  it("applies the caller's per-hop check", async () => {
    dnsAnswers.set('dev.local.test', '127.0.0.1');
    await expect(
      fetchGuarded(`http://dev.local.test:${port}/`, {
        allowedHosts: ['dev.local.test'],
        checkUrl: () => 'not in sidecar.outboundAllowlist',
      }),
    ).rejects.toThrow(/outboundAllowlist/);
    expect(hits).toEqual([]);
  });
});
