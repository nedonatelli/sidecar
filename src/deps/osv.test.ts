import { describe, it, expect, vi, afterEach } from 'vitest';
import { osvBatchQuery } from './osv.js';
import type { OsvQuery } from './osv.js';

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, json: async () => body }));
}

/** A lookup the test expects to succeed. */
async function lookup(queries: OsvQuery[]) {
  const r = await osvBatchQuery(queries);
  expect(r).not.toBeNull();
  return r!;
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
    const result = await lookup([npmQuery, pypiQuery]);
    expect(result).toHaveLength(2);
    expect(result[0][0].id).toBe('GHSA-aaa');
    expect(result[1]).toEqual([]);
  });

  it('maps severity from database_specific.severity', async () => {
    mockFetch(200, {
      results: [{ vulns: [{ id: 'X', summary: '', database_specific: { severity: 'HIGH' }, aliases: [] }] }],
    });
    const result = await lookup([npmQuery]);
    expect(result[0][0].severity).toBe('HIGH');
  });

  it('treats MODERATE as MEDIUM severity', async () => {
    mockFetch(200, {
      results: [{ vulns: [{ id: 'X', summary: '', database_specific: { severity: 'MODERATE' }, aliases: [] }] }],
    });
    const result = await lookup([npmQuery]);
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
    const result = await lookup([npmQuery]);
    expect(result[0][0].severity).toBe('CRITICAL');
  });

  it('returns UNKNOWN when no severity information exists', async () => {
    mockFetch(200, { results: [{ vulns: [{ id: 'Z', summary: '' }] }] });
    const result = await lookup([npmQuery]);
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

  // #119: a failed lookup used to read as "no vulnerabilities", and a scan
  // that timed out was cached as clean for an hour.
  it('returns null (not "no vulnerabilities") when the API returns non-ok status', async () => {
    mockFetch(500, {});
    expect(await osvBatchQuery([npmQuery, pypiQuery])).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    expect(await osvBatchQuery([npmQuery])).toBeNull();
  });

  // #119: /v1/querybatch returns ids only, so every finding read UNKNOWN.
  it('fetches the full record for a vuln the batch returned bare', async () => {
    const spy = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith('/querybatch')
          ? { results: [{ vulns: [{ id: 'GHSA-1', modified: '2026-01-01' }] }] }
          : {
              id: 'GHSA-1',
              summary: 'prototype pollution',
              database_specific: { severity: 'HIGH' },
              aliases: ['CVE-1'],
            },
    }));
    vi.stubGlobal('fetch', spy);
    const [[v]] = await lookup([npmQuery]);
    expect(v).toEqual({ id: 'GHSA-1', summary: 'prototype pollution', severity: 'HIGH', aliases: ['CVE-1'] });
    expect(spy.mock.calls[1][0]).toBe('https://api.osv.dev/v1/vulns/GHSA-1');
  });

  it('keeps the bare record when its detail fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/querybatch')
          ? { ok: true, json: async () => ({ results: [{ vulns: [{ id: 'GHSA-2' }] }] }) }
          : { ok: false, json: async () => ({}) },
      ),
    );
    const [[v]] = await lookup([npmQuery]);
    expect(v.id).toBe('GHSA-2');
    expect(v.severity).toBe('UNKNOWN');
  });

  it('does not read a CVSS vector as a LOW score', async () => {
    mockFetch(200, {
      results: [
        {
          vulns: [{ id: 'V', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }],
        },
      ],
    });
    const result = await lookup([npmQuery]);
    expect(result[0][0].severity).toBe('UNKNOWN');
  });

  it('returns empty array when results field is missing from response', async () => {
    mockFetch(200, {});
    const result = await lookup([npmQuery]);
    expect(result).toEqual([]);
  });

  it('populates aliases from the vuln object', async () => {
    mockFetch(200, {
      results: [{ vulns: [{ id: 'GHSA-abc', summary: 'test', aliases: ['CVE-2021-1234'] }] }],
    });
    const result = await lookup([npmQuery]);
    expect(result[0][0].aliases).toEqual(['CVE-2021-1234']);
  });

  it('uses UNKNOWN id when vuln id is absent', async () => {
    mockFetch(200, { results: [{ vulns: [{ summary: 'no id' }] }] });
    const result = await lookup([npmQuery]);
    expect(result[0][0].id).toBe('UNKNOWN');
  });
});
