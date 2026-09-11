import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { stableCloneDir } from './clonePath.js';

describe('stableCloneDir', () => {
  it('is deterministic: the same repo maps to the same directory every time', () => {
    // This is the property the random mkdtemp suffix broke. The directory is
    // the agent's `root`, the base prompt names it, and a run that cannot
    // reproduce its own prompt cannot reproduce its own trajectory -- a pinned
    // seed only fixes sampling for an identical input.
    const a = stableCloneDir('/tmp', 'django/django');
    const b = stableCloneDir('/tmp', 'django/django');
    expect(a).toBe(b);
  });

  it('carries no random component', () => {
    const dir = stableCloneDir('/tmp', 'django/django');
    expect(path.basename(dir)).toBe('swe-repo-django_django');
  });

  it('keeps distinct repos in distinct directories', () => {
    expect(stableCloneDir('/tmp', 'django/django')).not.toBe(stableCloneDir('/tmp', 'sympy/sympy'));
  });

  it('flattens the owner/name separator so it is one path segment', () => {
    // A literal "/" would make the repo name a subdirectory and put the clone
    // one level deeper than the sweeper looks.
    const dir = stableCloneDir('/tmp', 'scikit-learn/scikit-learn');
    expect(path.dirname(dir)).toBe(path.normalize('/tmp'));
  });

  it('matches the prefix the stale-clone sweeper keys on', () => {
    // sweepStaleClones() removes `swe-repo-*` older than six hours. A rename
    // that dropped the prefix would leave every clone permanently unswept.
    expect(path.basename(stableCloneDir('/tmp', 'x/y'))).toMatch(/^swe-repo-/);
  });
});
