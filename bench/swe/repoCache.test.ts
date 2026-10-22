import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { missingCachedRepos, repoCacheDir, repoCacheMissMessage } from './repoCache.js';

// #292: the driver checks the whole run's repositories before the first task.
describe('repoCache', () => {
  const base = path.resolve('/cache');
  const has = (present: string[]) => (p: string) =>
    present.some((repo) => p === path.join(repoCacheDir(base, repo), '.git'));

  it('keys a repo as owner_name under the cache', () => {
    expect(repoCacheDir(base, 'psf/requests')).toBe(path.join(base, 'psf_requests'));
  });

  it('lists the repos with no clone, once each, sorted', () => {
    const repos = ['psf/requests', 'django/django', 'django/django', 'astropy/astropy', 'sympy/sympy'];
    expect(missingCachedRepos(base, repos, has(['psf/requests', 'astropy/astropy']))).toEqual([
      'django/django',
      'sympy/sympy',
    ]);
  });

  it('is empty when every repo is cached', () => {
    expect(missingCachedRepos(base, ['psf/requests'], has(['psf/requests']))).toEqual([]);
  });

  it('the stop message names every missing repo and how to provision them', () => {
    const msg = repoCacheMissMessage(base, ['django/django', 'sympy/sympy']);
    expect(msg).toContain('django/django, sympy/sympy');
    expect(msg).toContain('run_local.sh');
    expect(msg).toContain('No task was started');
    expect(msg.startsWith('repo cache miss')).toBe(true);
  });
});
