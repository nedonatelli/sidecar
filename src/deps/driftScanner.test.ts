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
