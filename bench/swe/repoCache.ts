// ---------------------------------------------------------------------------
// The SWE repository cache (SIDECAR_SWE_REPO_CACHE): one clone per repo,
// provisioned ahead of time (bench/swe/local/run_local.sh), so a run doesn't
// clone over the network.
//
// The driver used to look a task's clone up only when that task started, and
// throw a per-task "repo cache miss". A run with half its repositories missing
// still started, then lost those tasks one at a time: the nemotron-3-super
// overnight queue (2026-10-21) spent 22 of 26 arm attempts that way (#292).
// missingCachedRepos lets the driver refuse before the first task instead.
// ---------------------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where a repo's clone lives in the cache: `owner/name` becomes `owner_name`. */
export function repoCacheDir(cacheBase: string, repo: string): string {
  return path.join(cacheBase, repo.replace(/[/\\]/g, '_'));
}

/** The repos among `repos` with no clone (no `.git`) in the cache, sorted and de-duplicated. */
export function missingCachedRepos(
  cacheBase: string,
  repos: Iterable<string>,
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  const missing = new Set<string>();
  for (const repo of repos) {
    if (!exists(path.join(repoCacheDir(cacheBase, repo), '.git'))) missing.add(repo);
  }
  return [...missing].sort();
}

/** The message a run stops with when its cache is missing repos. */
export function repoCacheMissMessage(cacheBase: string, missing: readonly string[]): string {
  return (
    `repo cache miss: ${missing.length} repo(s) needed by this run are not in SIDECAR_SWE_REPO_CACHE ` +
    `(${cacheBase}): ${missing.join(', ')}. Provision them first (bench/swe/local/run_local.sh clones ` +
    `into the cache), or unset SIDECAR_SWE_REPO_CACHE to clone per run. No task was started.`
  );
}
