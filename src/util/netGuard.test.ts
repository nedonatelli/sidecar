import { describe, it, expect, vi, beforeEach } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('dns/promises', () => ({ lookup: lookupMock }));

import { classifyAddress, classifyHostLiteral, urlBlockReason } from './netGuard.js';
import { validateScreenshotUrl } from '../agent/tools/visionHelpers.js';

beforeEach(() => {
  lookupMock.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.0.0.2', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['169.254.169.254', 'link-local'],
    ['10.1.2.3', 'private'],
    ['172.20.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['::ffff:7f00:1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fd12:3456::1', 'private'],
    ['8.8.8.8', 'public'],
    ['2606:4700::1111', 'public'],
  ])('%s is %s', (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });
});

// Every bypass of the old string checks (security review 2026-10).
describe('URLs the old checks let through', () => {
  it.each([
    'http://[::1]:3000/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://0.0.0.0:8080/',
    'http://localhost./',
    'http://app.localhost/',
    'http://127.0.0.2/',
    'http://2130706433/',
    'http://0x7f000001/',
  ])('validateScreenshotUrl blocks %s', (u) => {
    expect(validateScreenshotUrl(u)).not.toBeNull();
  });

  it('a public NAME that resolves to the metadata address is blocked', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    expect(await urlBlockReason('http://metadata.attacker.example/')).toMatch(/link-local/);
  });

  it('a name with any private address takes the most restrictive class', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    expect(await urlBlockReason('http://mixed.example/')).toMatch(/loopback/);
  });

  it('loopback is allowed only when listed; link-local never is', async () => {
    expect(await urlBlockReason('http://localhost:5173/', ['localhost'])).toBeNull();
    expect(await urlBlockReason('http://[::ffff:a9fe:a9fe]/', ['169.254.169.254', '[::ffff:a9fe:a9fe]'])).toMatch(
      /link-local/,
    );
  });

  it('public hosts and non-http schemes', async () => {
    expect(await urlBlockReason('https://example.com/')).toBeNull();
    expect(await urlBlockReason('file:///etc/passwd')).toMatch(/only http/);
    expect(classifyHostLiteral('example.com')).toBe('name');
  });
});
