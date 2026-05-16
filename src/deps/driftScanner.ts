import * as fs from 'fs/promises';
import * as path from 'path';
import type { DepEcosystem, DepResult, ManifestScanResult, ParsedDep } from './types.js';
import { stripRange, semverGt } from './semver.js';
import { parsePackageJson } from './parsers/packageJson.js';
import { parseRequirements } from './parsers/requirements.js';
import { parseCargoToml } from './parsers/cargoToml.js';
import { parseGoMod } from './parsers/goMod.js';
import { fetchNpmLatest } from './registries/npm.js';
import { fetchPypiLatest } from './registries/pypi.js';
import { fetchCargoLatest } from './registries/cargo.js';
import { fetchGoLatest } from './registries/go.js';
import { osvBatchQuery, type OsvQuery } from './osv.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  latestVersion: string;
  cachedAt: number;
}

export interface ScanOptions {
  checkVulnerabilities?: boolean;
  signal?: AbortSignal;
}

function ecosystemForManifest(manifestPath: string): DepEcosystem | undefined {
  const base = path.basename(manifestPath);
  if (base === 'package.json') return 'npm';
  if (base.startsWith('requirements') && base.endsWith('.txt')) return 'pypi';
  if (base === 'Cargo.toml') return 'cargo';
  if (base === 'go.mod') return 'go';
  return undefined;
}

function parseManifest(content: string, ecosystem: DepEcosystem): ParsedDep[] {
  switch (ecosystem) {
    case 'npm':
      return parsePackageJson(content);
    case 'pypi':
      return parseRequirements(content);
    case 'cargo':
      return parseCargoToml(content);
    case 'go':
      return parseGoMod(content);
  }
}

async function fetchLatest(
  dep: ParsedDep,
  cache: Map<string, CacheEntry>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const key = `${dep.ecosystem}:${dep.name}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.latestVersion;
  }

  let latest: string | undefined;
  switch (dep.ecosystem) {
    case 'npm':
      latest = await fetchNpmLatest(dep.name, signal);
      break;
    case 'pypi':
      latest = await fetchPypiLatest(dep.name, signal);
      break;
    case 'cargo':
      latest = await fetchCargoLatest(dep.name, signal);
      break;
    case 'go':
      latest = await fetchGoLatest(dep.name, signal);
      break;
  }

  if (latest) {
    cache.set(key, { latestVersion: latest, cachedAt: Date.now() });
  }
  return latest;
}

export class DriftScanner {
  private readonly versionCache = new Map<string, CacheEntry>();

  /** Scan a list of manifest files and return dependency drift + vulnerability data. */
  async scan(manifestPaths: string[], opts: ScanOptions = {}): Promise<ManifestScanResult[]> {
    const results: ManifestScanResult[] = [];

    for (const manifestPath of manifestPaths) {
      const ecosystem = ecosystemForManifest(manifestPath);
      if (!ecosystem) continue;

      let content: string;
      try {
        content = await fs.readFile(manifestPath, 'utf-8');
      } catch (err) {
        results.push({ manifestPath, ecosystem, deps: [], error: String(err) });
        continue;
      }

      const parsed = parseManifest(content, ecosystem);

      // Fetch latest versions in parallel (up to 10 at a time to avoid hammering registries)
      const CONCURRENCY = 10;
      const depResults: DepResult[] = [];

      for (let i = 0; i < parsed.length; i += CONCURRENCY) {
        const batch = parsed.slice(i, i + CONCURRENCY);
        const latests = await Promise.all(batch.map((d) => fetchLatest(d, this.versionCache, opts.signal)));

        for (let j = 0; j < batch.length; j++) {
          const dep = batch[j];
          const latest = latests[j];
          const current = stripRange(dep.specifiedVersion);
          const latestVer = latest ?? current;
          depResults.push({
            name: dep.name,
            ecosystem: dep.ecosystem,
            specifiedVersion: dep.specifiedVersion,
            currentVersion: current,
            latestVersion: latestVer,
            isOutdated: !!latest && semverGt(latest, current),
            vulnerabilities: [],
            dev: dep.dev,
          });
        }
      }

      // Batch OSV vulnerability check
      if (opts.checkVulnerabilities !== false) {
        const queries: OsvQuery[] = depResults
          .filter((d) => d.currentVersion && d.currentVersion !== '0.0.0')
          .map((d) => ({ name: d.name, version: d.currentVersion, ecosystem: d.ecosystem }));

        if (queries.length > 0) {
          const vulnResults = await osvBatchQuery(queries, opts.signal);
          let qi = 0;
          for (const dep of depResults) {
            if (dep.currentVersion && dep.currentVersion !== '0.0.0') {
              dep.vulnerabilities = vulnResults[qi] ?? [];
              qi++;
            }
          }
        }
      }

      results.push({ manifestPath, ecosystem, deps: depResults });
    }

    return results;
  }

  /** Clear the version cache (useful in tests or when the user forces a refresh). */
  clearCache(): void {
    this.versionCache.clear();
  }
}
