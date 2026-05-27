import { describe, it, expect, vi, afterEach } from 'vitest';
import { osvBatchQuery } from './osv.js';
import type { OsvQuery } from './osv.js';

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, json: async () => body }));
}

const npmQuery: OsvQuery = { name: 'lodash', version: '4.17.20', ecosystem: 'npm' };
const pypiQuery: OsvQuery = { name: 'requests', version: '2.25.0', ecosystem: 'pypi' };

describe('osvBatchQuery', () => {
  it('returns empty array for empty input without fetching', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await osvBatchQuery([]);
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps results in input order', async () => {
    mockFetch(200, {
      results: [{ vulns: [{ id: 'GHSA-aaa', summary: 'proto pollution', aliases: [] }] }, { vulns: [] }],
    });
    const result = await osvBatchQuery([npmQuery, pypiQuery]);
    expect(result).toHaveLength(2);
    expect(result[0][0].id).toBe('GHSA-aaa');
    expect(result[1]).toEqual([]);
  });

  it('maps severity from database_specific.severity', async () => {
    mockFetch(200, {
      results: [{ vulns: [{ id: 'X', summary: '', database_specific: { severity: 'HIGH' }, aliases: [] }] }],
    });
    const result = await osvBatchQuery([npmQuery]);
    expect(result[0][0].severity).toBe('HIGH');
  });

  it('treats MODERATE as MEDIUM severity', async () => {
    mockFetch(200, {
      results: [{ vulns: [{ id: 'X', summary: '', database_specific: { severity: 'MODERATE' }, aliases: [] }] }],
    });
    const result = await osvBatchQuery([npmQuery]);
    expect(result[0][0].severity).toBe('MEDIUM');
  });

  it('falls back to CVSS score when database_specific.severity is absent', async () => {
    mockFetch(200, {
      results: [
        {
          vulns: [
            {
              id: 'Y',
              summary: '',
              severity: [{ type: 'CVSS_V3', score: '9.8' }],
              aliases: [],
            },
          ],
        },
      ],
    });
    const result = await osvBatchQuery([npmQuery]);
    expect(result[0][0].severity).toBe('CRITICAL');
  });

  it('returns UNKNOWN when no severity information exists', async () => {
    mockFetch(200, { results: [{ vulns: [{ id: 'Z', summary: '' }] }] });
    const result = await osvBatchQuery([npmQuery]);
    expect(result[0][0].severity).toBe('UNKNOWN');
  });

  it('maps ecosystem names correctly (PyPI, crates.io, Go)', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{}, {}, {}] }) });
    vi.stubGlobal('fetch', spy);
    await osvBatchQuery([
      { name: 'requests', version: '2.0.0', ecosystem: 'pypi' },
      { name: 'serde', version: '1.0.0', ecosystem: 'cargo' },
      { name: 'golang.org/x/net', version: 'v0.1.0', ecosystem: 'go' },
    ]);
    const body = JSON.parse(spy.mock.calls[0][1].body as string) as {
      queries: Array<{ package: { ecosystem: string } }>;
    };
    expect(body.queries[0].package.ecosystem).toBe('PyPI');
    expect(body.queries[1].package.ecosystem).toBe('crates.io');
    expect(body.queries[2].package.ecosystem).toBe('Go');
  });

  it('returns empty arrays per query when the API returns non-ok status', async () => {
    mockFetch(500, {});
    const result = await osvBatchQuery([npmQuery, pypiQuery]);
    expect(result).toEqual([[], []]);
  });

  it('returns empty arrays per query when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const result = await osvBatchQuery([npmQuery]);
    expect(result).toEqual([[]]);
  });

  it('returns empty array when results field is missing from response', async () => {
    mockFetch(200, {});
    const result = await osvBatchQuery([npmQuery]);
    expect(result).toEqual([]);
  });

  it('populates aliases from the vuln object', async () => {
    mockFetch(200, {
      results: [{ vulns: [{ id: 'GHSA-abc', summary: 'test', aliases: ['CVE-2021-1234'] }] }],
    });
    const result = await osvBatchQuery([npmQuery]);
    expect(result[0][0].aliases).toEqual(['CVE-2021-1234']);
  });

  it('uses UNKNOWN id when vuln id is absent', async () => {
    mockFetch(200, { results: [{ vulns: [{ summary: 'no id' }] }] });
    const result = await osvBatchQuery([npmQuery]);
    expect(result[0][0].id).toBe('UNKNOWN');
  });
});
