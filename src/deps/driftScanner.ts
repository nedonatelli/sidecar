import * as fs from 'fs/promises';
import * as path from 'path';
import type { DepEcosystem, DepResult, ManifestScanResult, ParsedDep } from './types.js';
import { stripRange, semverGt } from './semver.js';
import { logger, kv } from '../system/logger.js';
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

/**
 * The versions npm actually installed, read from the lockfile beside a
 * package.json (`npm-shrinkwrap.json` wins over `package-lock.json`, as in
 * npm). Empty when there is no readable lockfile. A range such as `^4.17.0`
 * says nothing about what was installed; querying OSV at its floor reported
 * advisories fixed in the version every install resolves to.
 */
async function readNpmLockedVersions(manifestPath: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  for (const lockName of ['npm-shrinkwrap.json', 'package-lock.json']) {
    let lock: {
      packages?: Record<string, { version?: unknown }>;
      dependencies?: Record<string, { version?: unknown }>;
    };
    try {
      lock = JSON.parse(await fs.readFile(path.join(path.dirname(manifestPath), lockName), 'utf-8'));
    } catch {
      continue;
    }
    if (!lock || typeof lock !== 'object') continue;
    // lockfileVersion 2/3: `packages["node_modules/<name>"]`; 1: `dependencies[<name>]`.
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      // Top-level installs only; `node_modules/a/node_modules/b` is a nested copy.
      if (key.lastIndexOf('node_modules/') !== 0) continue;
      if (typeof entry?.version === 'string') versions.set(key.slice('node_modules/'.length), entry.version);
    }
    for (const [name, entry] of Object.entries(lock.dependencies ?? {})) {
      if (!versions.has(name) && typeof entry?.version === 'string') versions.set(name, entry.version);
    }
    return versions;
  }
  return versions;
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
      let incomplete = false;
      if (opts.checkVulnerabilities !== false) {
        // Query the installed version when a lockfile gives it; otherwise the
        // range's floor, the only version the manifest names.
        const locked = ecosystem === 'npm' ? await readNpmLockedVersions(manifestPath) : new Map<string, string>();
        const queries: OsvQuery[] = depResults
          .filter((d) => d.currentVersion && d.currentVersion !== '0.0.0')
          .map((d) => ({ name: d.name, version: locked.get(d.name) ?? d.currentVersion, ecosystem: d.ecosystem }));

        if (queries.length > 0) {
          const vulnResults = await osvBatchQuery(queries, opts.signal);
          if (vulnResults === null) incomplete = true;
          let qi = 0;
          for (const dep of depResults) {
            if (dep.currentVersion && dep.currentVersion !== '0.0.0') {
              dep.vulnerabilities = vulnResults?.[qi] ?? [];
              qi++;
            }
          }
        }
      }

      results.push({ manifestPath, ecosystem, deps: depResults, ...(incomplete ? { incomplete } : {}) });
    }

    const allDeps = results.flatMap((r) => r.deps);
    logger.debug(
      `[deps] scan complete${kv({
        manifests: results.length,
        deps: allDeps.length,
        outdated: allDeps.filter((d) => d.isOutdated).length,
        vulnerable: allDeps.filter((d) => d.vulnerabilities.length > 0).length,
      })}`,
    );
    return results;
  }

  /** Clear the version cache (useful in tests or when the user forces a refresh). */
  clearCache(): void {
    this.versionCache.clear();
  }
}
