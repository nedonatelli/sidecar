import { describe, it, expect } from 'vitest';
import { loadFacetRegistry, type FacetFsOverride } from './facetDiskLoader.js';
import { builtInFacets } from './facetLoader.js';

// ---------------------------------------------------------------------------
// Tests for facetDiskLoader.ts (v0.66 chunk 3.5a).
//
// The disk loader composes the built-in catalog with any facets found
// at `<workspace>/.sidecar/facets/*.md` + an explicit list of paths
// from `sidecar.facets.registry`. It's tolerant: per-file errors go
// into the outcome's `errors` array without aborting the load, and
// registry-level failures fall back to built-ins only so the Expert
// Panel is never empty.
// ---------------------------------------------------------------------------

function fs(files: Record<string, string>, dirs: Record<string, string[]> = {}): FacetFsOverride {
  return {
    async readFile(absolutePath: string): Promise<string> {
      if (!(absolutePath in files)) throw new Error(`ENOENT: ${absolutePath}`);
      return files[absolutePath];
    },
    async readDirectory(absolutePath: string): Promise<string[]> {
      if (absolutePath in dirs) return dirs[absolutePath];
      throw new Error(`ENOENT: ${absolutePath}`);
    },
  };
}

const validFacet = (id: string, displayName: string, body = 'body'): string =>
  `---\nid: ${id}\ndisplayName: ${displayName}\n---\n${body}\n`;

describe('loadFacetRegistry — built-ins only', () => {
  it('returns the full built-in catalog when no disk sources are configured', async () => {
    const outcome = await loadFacetRegistry({ fsOverride: fs({}) });
    expect(outcome.errors).toEqual([]);
    expect(outcome.registry.all.length).toBe(builtInFacets().length);
  });

  it('silently handles a missing .sidecar/facets/ directory (no error)', async () => {
    const outcome = await loadFacetRegistry({
      workspaceRoot: '/workspace',
      fsOverride: fs({}, {}),
    });
    expect(outcome.errors).toEqual([]);
    expect(outcome.registry.all.length).toBe(builtInFacets().length);
  });
});

describe('loadFacetRegistry — project facets (.sidecar/facets)', () => {
  it('loads every .md file from the workspace facets dir', async () => {
    const outcome = await loadFacetRegistry({
      workspaceRoot: '/workspace',
      fsOverride: fs(
        {
          '/workspace/.sidecar/facets/a.md': validFacet('custom-a', 'Custom A'),
          '/workspace/.sidecar/facets/b.md': validFacet('custom-b', 'Custom B'),
        },
        { '/workspace/.sidecar/facets': ['a.md', 'b.md', 'README.txt'] },
      ),
    });
    expect(outcome.errors).toEqual([]);
    expect(outcome.registry.get('custom-a')?.displayName).toBe('Custom A');
    expect(outcome.registry.get('custom-b')?.displayName).toBe('Custom B');
  });

  it('ignores non-markdown entries in the directory', async () => {
    const outcome = await loadFacetRegistry({
      workspaceRoot: '/workspace',
      fsOverride: fs(
        { '/workspace/.sidecar/facets/a.md': validFacet('x', 'X') },
        { '/workspace/.sidecar/facets': ['a.md', 'notes.txt', 'x.json'] },
      ),
    });
    expect(outcome.errors).toEqual([]);
    expect(outcome.registry.has('x')).toBe(true);
  });

  it('records a per-file error for a malformed facet but still loads the others', async () => {
    const outcome = await loadFacetRegistry({
      workspaceRoot: '/workspace',
      fsOverride: fs(
        {
          '/workspace/.sidecar/facets/good.md': validFacet('good', 'Good'),
          '/workspace/.sidecar/facets/bad.md': 'no frontmatter here',
        },
        { '/workspace/.sidecar/facets': ['good.md', 'bad.md'] },
      ),
    });
    expect(outcome.registry.has('good')).toBe(true);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].reason).toBe('missing-frontmatter');
    expect(outcome.errors[0].filePath).toBe('/workspace/.sidecar/facets/bad.md');
  });

  it('marks project facets with source: project', async () => {
    const outcome = await loadFacetRegistry({
      workspaceRoot: '/workspace',
      fsOverride: fs(
        { '/workspace/.sidecar/facets/p.md': validFacet('p', 'P') },
        { '/workspace/.sidecar/facets': ['p.md'] },
      ),
    });
    expect(outcome.registry.get('p')?.source).toBe('project');
  });
});

describe('loadFacetRegistry — registry paths (sidecar.facets.registry)', () => {
  it('loads facets from absolute paths supplied via config', async () => {
    const outcome = await loadFacetRegistry({
      registryPaths: ['/user/my-facet.md'],
      fsOverride: fs({ '/user/my-facet.md': validFacet('mine', 'Mine') }),
    });
    expect(outcome.registry.has('mine')).toBe(true);
    expect(outcome.registry.get('mine')?.source).toBe('user');
  });

  it('records io-error when a configured path is unreadable', async () => {
    const outcome = await loadFacetRegistry({
      registryPaths: ['/missing.md'],
      fsOverride: fs({}),
    });
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].reason).toBe('io-error');
    expect(outcome.errors[0].filePath).toBe('/missing.md');
  });
});

describe('loadFacetRegistry — merge precedence', () => {
  it('disk-loaded facet with a built-in id replaces the built-in', async () => {
    const outcome = await loadFacetRegistry({
      registryPaths: ['/override.md'],
      fsOverride: fs({
        '/override.md': validFacet('general-coder', 'Custom Coder'),
      }),
    });
    const gc = outcome.registry.get('general-coder');
    expect(gc?.displayName).toBe('Custom Coder');
    expect(gc?.source).toBe('user');
  });

  it('rejects two disk facets sharing an id; keeps first, errors on second', async () => {
    const outcome = await loadFacetRegistry({
      workspaceRoot: '/ws',
      registryPaths: ['/extra.md'],
      fsOverride: fs(
        {
          '/ws/.sidecar/facets/dup.md': validFacet('same-id', 'Project Version'),
          '/extra.md': validFacet('same-id', 'User Version'),
        },
        { '/ws/.sidecar/facets': ['dup.md'] },
      ),
    });
    // Project scanned first (registered), user rejected (duplicate).
    expect(outcome.registry.get('same-id')?.displayName).toBe('Project Version');
    const dupError = outcome.errors.find((e) => e.reason === 'duplicate-id');
    expect(dupError?.filePath).toBe('/extra.md');
  });
});

describe('loadFacetRegistry — registry-level fallback', () => {
  it('falls back to built-ins only when disk facets form a dependency cycle', async () => {
    // Two disk facets that reference each other — registry build will throw.
    const outcome = await loadFacetRegistry({
      registryPaths: ['/a.md', '/b.md'],
      fsOverride: fs({
        '/a.md': `---\nid: a\ndisplayName: A\ndependsOn: ["b"]\n---\nbody\n`,
        '/b.md': `---\nid: b\ndisplayName: B\ndependsOn: ["a"]\n---\nbody\n`,
      }),
    });
    // Disk facets dropped; built-ins survive.
    expect(outcome.registry.has('a')).toBe(false);
    expect(outcome.registry.has('b')).toBe(false);
    expect(outcome.registry.has('general-coder')).toBe(true);
    // Error reports the cycle.
    const cycleErr = outcome.errors.find((e) => e.reason === 'cycle');
    expect(cycleErr).toBeDefined();
    expect(cycleErr?.message).toMatch(/cycle|rejected by registry validation/);
  });

  it('falls back to built-ins when a disk facet references a nonexistent dependency', async () => {
    const outcome = await loadFacetRegistry({
      registryPaths: ['/a.md'],
      fsOverride: fs({
        '/a.md': `---\nid: a\ndisplayName: A\ndependsOn: ["ghost"]\n---\nbody\n`,
      }),
    });
    expect(outcome.registry.has('a')).toBe(false);
    expect(outcome.registry.has('general-coder')).toBe(true);
  });
});
