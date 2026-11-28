import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DriftScanner } from './driftScanner.js';

// Mock fs/promises so no real file I/O happens
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock all registries and OSV
vi.mock('./registries/npm.js', () => ({ fetchNpmLatest: vi.fn() }));
vi.mock('./registries/pypi.js', () => ({ fetchPypiLatest: vi.fn() }));
vi.mock('./registries/cargo.js', () => ({ fetchCargoLatest: vi.fn() }));
vi.mock('./registries/go.js', () => ({ fetchGoLatest: vi.fn() }));
vi.mock('./osv.js', () => ({ osvBatchQuery: vi.fn() }));

import * as fsMod from 'fs/promises';
import * as npmReg from './registries/npm.js';
import * as pypiReg from './registries/pypi.js';
import * as osvMod from './osv.js';

const mockReadFile = fsMod.readFile as ReturnType<typeof vi.fn>;
const mockNpmLatest = npmReg.fetchNpmLatest as ReturnType<typeof vi.fn>;
const mockPypiLatest = pypiReg.fetchPypiLatest as ReturnType<typeof vi.fn>;
const mockOsv = osvMod.osvBatchQuery as ReturnType<typeof vi.fn>;

describe('DriftScanner', () => {
  let scanner: DriftScanner;

  beforeEach(() => {
    scanner = new DriftScanner();
    vi.clearAllMocks();
    mockOsv.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty results for unknown manifest type', async () => {
    const results = await scanner.scan(['/workspace/Makefile']);
    expect(results).toHaveLength(0);
  });

  it('surfaces error when manifest cannot be read', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const results = await scanner.scan(['/workspace/package.json']);
    expect(results).toHaveLength(1);
    expect(results[0].error).toBeDefined();
    expect(results[0].deps).toHaveLength(0);
  });

  it('detects an outdated npm package', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ dependencies: { lodash: '^4.17.0' }, devDependencies: {} }));
    mockNpmLatest.mockResolvedValue('4.17.21');
    mockOsv.mockResolvedValue([[]]); // no vulns

    const [result] = await scanner.scan(['/workspace/package.json']);
    expect(result.error).toBeUndefined();
    const dep = result.deps.find((d) => d.name === 'lodash');
    expect(dep?.isOutdated).toBe(true);
    expect(dep?.latestVersion).toBe('4.17.21');
    expect(dep?.currentVersion).toBe('4.17.0');
  });

  it('marks a package as not outdated when already at latest', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ dependencies: { express: '4.18.2' } }));
    mockNpmLatest.mockResolvedValue('4.18.2');
    mockOsv.mockResolvedValue([[]]); // no vulns

    const [result] = await scanner.scan(['/workspace/package.json']);
    const dep = result.deps.find((d) => d.name === 'express');
    expect(dep?.isOutdated).toBe(false);
  });

  it('attaches vulnerabilities from OSV to the correct dep', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ dependencies: { axios: '0.21.0' } }));
    mockNpmLatest.mockResolvedValue('1.6.0');
    mockOsv.mockResolvedValue([[{ id: 'GHSA-1234', summary: 'SSRF vulnerability', severity: 'HIGH', aliases: [] }]]);

    const [result] = await scanner.scan(['/workspace/package.json'], { checkVulnerabilities: true });
    const dep = result.deps.find((d) => d.name === 'axios');
    expect(dep?.vulnerabilities).toHaveLength(1);
    expect(dep?.vulnerabilities[0].id).toBe('GHSA-1234');
    expect(dep?.vulnerabilities[0].severity).toBe('HIGH');
  });

  // #119: a failed lookup read as "no vulnerabilities" and was cached as clean.
  // A range was queried at its floor, so `^4.17.0` reported advisories fixed
  // in the version the lockfile actually installs. (#427)
  describe('the version queried for vulnerabilities', () => {
    const manifest = JSON.stringify({ dependencies: { lodash: '^4.17.0', '@s/p': '~1.0.0', left: '^1.0.0' } });
    afterEach(() => mockReadFile.mockReset());
    function files(byName: Record<string, string>): void {
      mockReadFile.mockImplementation(async (p: string) => {
        const name = String(p).replace(/\\/g, '/').split('/').pop() ?? '';
        if (name in byName) return byName[name];
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
    }
    function queried(): Record<string, string> {
      const queries = mockOsv.mock.calls[0][0] as { name: string; version: string }[];
      return Object.fromEntries(queries.map((q) => [q.name, q.version]));
    }

    it('is the version package-lock.json installed', async () => {
      files({
        'package.json': manifest,
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: {} },
            'node_modules/lodash': { version: '4.17.21' },
            'node_modules/@s/p': { version: '1.0.9' },
            'node_modules/other/node_modules/left': { version: '9.9.9' },
          },
        }),
      });
      mockNpmLatest.mockResolvedValue(undefined);
      await scanner.scan(['/workspace/package.json']);
      // A nested copy is not the top-level install, so `left` falls back to the floor.
      expect(queried()).toEqual({ lodash: '4.17.21', '@s/p': '1.0.9', left: '1.0.0' });
    });

    it('reads a lockfileVersion 1 lockfile', async () => {
      files({
        'package.json': manifest,
        'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: { lodash: { version: '4.17.21' } } }),
      });
      mockNpmLatest.mockResolvedValue(undefined);
      await scanner.scan(['/workspace/package.json']);
      expect(queried().lodash).toBe('4.17.21');
    });

    it('is the floor of the range when there is no lockfile', async () => {
      files({ 'package.json': manifest });
      mockNpmLatest.mockResolvedValue(undefined);
      await scanner.scan(['/workspace/package.json']);
      expect(queried()).toEqual({ lodash: '4.17.0', '@s/p': '1.0.0', left: '1.0.0' });
    });
  });

  it('marks the result incomplete when the vulnerability lookup fails', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ dependencies: { lodash: '^4.17.0' }, devDependencies: {} }));
    mockNpmLatest.mockResolvedValue('4.17.21');
    mockOsv.mockResolvedValue(null);
    const [result] = await scanner.scan(['/workspace/package.json']);
    expect(result.incomplete).toBe(true);
    expect(result.deps[0].vulnerabilities).toEqual([]);
  });

  it('skips OSV call when checkVulnerabilities is false', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    mockNpmLatest.mockResolvedValue('18.2.0');

    await scanner.scan(['/workspace/package.json'], { checkVulnerabilities: false });
    expect(mockOsv).not.toHaveBeenCalled();
  });

  it('caches latest version and does not refetch within TTL', async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { react: '^18.0.0' } }))
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    mockNpmLatest.mockResolvedValue('18.2.0');
    mockOsv.mockResolvedValue([[]]);

    await scanner.scan(['/workspace/package.json'], { checkVulnerabilities: false });
    await scanner.scan(['/workspace/package.json'], { checkVulnerabilities: false });

    // fetchNpmLatest should only be called once (second call hits cache)
    expect(mockNpmLatest).toHaveBeenCalledTimes(1);
  });

  it('clearCache forces a fresh fetch', async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { react: '^18.0.0' } }))
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    mockNpmLatest.mockResolvedValue('18.2.0');
    mockOsv.mockResolvedValue([[]]);

    await scanner.scan(['/workspace/package.json'], { checkVulnerabilities: false });
    scanner.clearCache();
    await scanner.scan(['/workspace/package.json'], { checkVulnerabilities: false });

    expect(mockNpmLatest).toHaveBeenCalledTimes(2);
  });

  it('parses pypi requirements.txt', async () => {
    mockReadFile.mockResolvedValueOnce('requests==2.28.0\nflask>=2.0.0\n');
    mockPypiLatest.mockResolvedValue('2.32.0');
    mockOsv.mockResolvedValue([[], []]);

    const [result] = await scanner.scan(['/workspace/requirements.txt']);
    expect(result.ecosystem).toBe('pypi');
    expect(result.deps.some((d) => d.name === 'requests')).toBe(true);
    expect(result.deps.some((d) => d.name === 'flask')).toBe(true);
  });

  it('uses current version as latest when registry returns undefined', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ dependencies: { 'my-private-pkg': '1.0.0' } }));
    mockNpmLatest.mockResolvedValue(undefined);

    const [result] = await scanner.scan(['/workspace/package.json'], { checkVulnerabilities: false });
    const dep = result.deps.find((d) => d.name === 'my-private-pkg');
    expect(dep?.isOutdated).toBe(false);
    expect(dep?.latestVersion).toBe(dep?.currentVersion);
  });
});
