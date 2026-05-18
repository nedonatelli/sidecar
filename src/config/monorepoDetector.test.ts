import { describe, it, expect } from 'vitest';
import { detectMonorepo } from './monorepoDetector.js';
import type { FsAdapter } from './monorepoDetector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type VirtualFs = {
  files: Record<string, string>; // abs path → content
  dirs: Record<string, string[]>; // abs path → entries
};

function makeFs(vfs: VirtualFs): FsAdapter {
  return {
    async readFile(p) {
      return p in vfs.files ? vfs.files[p] : null;
    },
    async listDir(p) {
      return vfs.dirs[p] ?? [];
    },
    async isDir(p) {
      return p in vfs.dirs;
    },
  };
}

const ROOT = '/repo';

// ---------------------------------------------------------------------------
// pnpm-workspace.yaml
// ---------------------------------------------------------------------------
describe('pnpm workspace', () => {
  it('detects type=pnpm and discovers packages from packages/* glob', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/pnpm-workspace.yaml`]: 'packages:\n  - packages/*\n',
        [`${ROOT}/packages/auth/package.json`]: JSON.stringify({ name: '@company/auth' }),
        [`${ROOT}/packages/ui/package.json`]: JSON.stringify({ name: '@company/ui' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['auth', 'ui'],
        [`${ROOT}/packages/auth`]: [],
        [`${ROOT}/packages/ui`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('pnpm');
    expect(info.packages).toHaveLength(2);
    expect(info.packages[0].name).toBe('@company/auth');
    expect(info.packages[0].relativePath).toBe('packages/auth');
    expect(info.packages[1].name).toBe('@company/ui');
  });

  it('skips exclusion patterns (starting with !)', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/pnpm-workspace.yaml`]: 'packages:\n  - packages/*\n  - "!packages/internal"\n',
        [`${ROOT}/packages/lib/package.json`]: JSON.stringify({ name: 'lib' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['lib'],
        [`${ROOT}/packages/lib`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('pnpm');
    expect(info.packages).toHaveLength(1);
    expect(info.packages[0].name).toBe('lib');
  });

  it('falls back to directory name when package.json is absent', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/pnpm-workspace.yaml`]: 'packages:\n  - packages/*\n',
      },
      dirs: {
        [`${ROOT}/packages`]: ['no-manifest'],
        [`${ROOT}/packages/no-manifest`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.packages[0].name).toBe('no-manifest');
  });
});

// ---------------------------------------------------------------------------
// Nx workspace
// ---------------------------------------------------------------------------
describe('nx workspace', () => {
  it('detects type=nx; reads package roots from package.json#workspaces', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/nx.json`]: '{}',
        [`${ROOT}/package.json`]: JSON.stringify({ workspaces: ['packages/*'] }),
        [`${ROOT}/packages/core/package.json`]: JSON.stringify({ name: '@nx/core' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['core'],
        [`${ROOT}/packages/core`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('nx');
    expect(info.packages[0].name).toBe('@nx/core');
  });

  it('falls back to scanning default dirs when no workspaces field', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/nx.json`]: '{}',
        [`${ROOT}/package.json`]: '{}',
        [`${ROOT}/apps/web/package.json`]: JSON.stringify({ name: 'web' }),
      },
      dirs: {
        [`${ROOT}/apps`]: ['web'],
        [`${ROOT}/apps/web`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('nx');
    expect(info.packages[0].relativePath).toBe('apps/web');
  });
});

// ---------------------------------------------------------------------------
// Turborepo
// ---------------------------------------------------------------------------
describe('turborepo', () => {
  it('detects type=turbo from turbo.json', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/turbo.json`]: '{"pipeline":{}}',
        [`${ROOT}/package.json`]: JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }),
        [`${ROOT}/apps/next/package.json`]: JSON.stringify({ name: 'next-app' }),
        [`${ROOT}/packages/tsconfig/package.json`]: JSON.stringify({ name: '@acme/tsconfig' }),
      },
      dirs: {
        [`${ROOT}/apps`]: ['next'],
        [`${ROOT}/apps/next`]: [],
        [`${ROOT}/packages`]: ['tsconfig'],
        [`${ROOT}/packages/tsconfig`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('turbo');
    expect(info.packages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Lerna
// ---------------------------------------------------------------------------
describe('lerna', () => {
  it('detects type=lerna from lerna.json packages array', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/lerna.json`]: JSON.stringify({ packages: ['packages/*'] }),
        [`${ROOT}/packages/utils/package.json`]: JSON.stringify({ name: '@lerna/utils' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['utils'],
        [`${ROOT}/packages/utils`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('lerna');
    expect(info.packages[0].name).toBe('@lerna/utils');
  });

  it('defaults to packages/* when lerna.json has no packages field', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/lerna.json`]: '{}',
        [`${ROOT}/packages/a/package.json`]: JSON.stringify({ name: 'a' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['a'],
        [`${ROOT}/packages/a`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('lerna');
    expect(info.packages[0].relativePath).toBe('packages/a');
  });
});

// ---------------------------------------------------------------------------
// yarn / npm workspaces (via package.json)
// ---------------------------------------------------------------------------
describe('yarn / npm workspaces', () => {
  it('detects type=yarn from package.json#workspaces array', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/package.json`]: JSON.stringify({ workspaces: ['packages/*'] }),
        [`${ROOT}/packages/logger/package.json`]: JSON.stringify({ name: 'logger' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['logger'],
        [`${ROOT}/packages/logger`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('yarn');
    expect(info.packages[0].name).toBe('logger');
  });

  it('handles the hoisted-workspaces object form { packages: [...] }', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/package.json`]: JSON.stringify({ workspaces: { packages: ['packages/*'], nohoist: [] } }),
        [`${ROOT}/packages/sdk/package.json`]: JSON.stringify({ name: 'sdk' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['sdk'],
        [`${ROOT}/packages/sdk`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('yarn');
    expect(info.packages[0].name).toBe('sdk');
  });
});

// ---------------------------------------------------------------------------
// Structural fallback (packages/ or apps/ without a manifest)
// ---------------------------------------------------------------------------
describe('structural fallback', () => {
  it('returns type=none with discovered packages when only directory structure matches', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/packages/parser/package.json`]: JSON.stringify({ name: 'parser' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['parser'],
        [`${ROOT}/packages/parser`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('none');
    expect(info.packages[0].name).toBe('parser');
    expect(info.packages[0].relativePath).toBe('packages/parser');
  });

  it('scans apps/, libs/, and services/ directories', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/apps/web/package.json`]: JSON.stringify({ name: 'web' }),
        [`${ROOT}/libs/common/package.json`]: JSON.stringify({ name: 'common' }),
        [`${ROOT}/services/api/package.json`]: JSON.stringify({ name: 'api' }),
      },
      dirs: {
        [`${ROOT}/apps`]: ['web'],
        [`${ROOT}/apps/web`]: [],
        [`${ROOT}/libs`]: ['common'],
        [`${ROOT}/libs/common`]: [],
        [`${ROOT}/services`]: ['api'],
        [`${ROOT}/services/api`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('none');
    expect(info.packages.map((p) => p.name)).toEqual(['web', 'common', 'api']);
  });

  it('skips dotfile and underscore entries in structural scan', async () => {
    const fs = makeFs({
      files: {},
      dirs: {
        [`${ROOT}/packages`]: ['.hidden', '_internal', 'real'],
        [`${ROOT}/packages/real`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.packages).toHaveLength(1);
    expect(info.packages[0].name).toBe('real');
  });

  it('returns type=none with empty packages when no monorepo layout detected', async () => {
    const fs = makeFs({ files: {}, dirs: {} });
    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('none');
    expect(info.packages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------
describe('detection priority', () => {
  it('prefers pnpm-workspace.yaml over lerna.json and package.json', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/pnpm-workspace.yaml`]: 'packages:\n  - packages/*\n',
        [`${ROOT}/lerna.json`]: JSON.stringify({ packages: ['packages/*'] }),
        [`${ROOT}/package.json`]: JSON.stringify({ workspaces: ['packages/*'] }),
        [`${ROOT}/packages/x/package.json`]: JSON.stringify({ name: 'x' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['x'],
        [`${ROOT}/packages/x`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('pnpm');
  });

  it('prefers nx.json over turbo.json', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/nx.json`]: '{}',
        [`${ROOT}/turbo.json`]: '{}',
        [`${ROOT}/package.json`]: JSON.stringify({ workspaces: ['packages/*'] }),
        [`${ROOT}/packages/lib/package.json`]: JSON.stringify({ name: 'lib' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['lib'],
        [`${ROOT}/packages/lib`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.type).toBe('nx');
  });
});

// ---------------------------------------------------------------------------
// Glob forms
// ---------------------------------------------------------------------------
describe('glob expansion', () => {
  it('expands /** the same way as /*', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/pnpm-workspace.yaml`]: 'packages:\n  - packages/**\n',
        [`${ROOT}/packages/foo/package.json`]: JSON.stringify({ name: 'foo' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['foo'],
        [`${ROOT}/packages/foo`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.packages[0].name).toBe('foo');
  });

  it('handles ./packages/* (leading ./)', async () => {
    const fs = makeFs({
      files: {
        [`${ROOT}/package.json`]: JSON.stringify({ workspaces: ['./packages/*'] }),
        [`${ROOT}/packages/bar/package.json`]: JSON.stringify({ name: 'bar' }),
      },
      dirs: {
        [`${ROOT}/packages`]: ['bar'],
        [`${ROOT}/packages/bar`]: [],
      },
    });

    const info = await detectMonorepo(ROOT, fs);
    expect(info.packages[0].name).toBe('bar');
  });
});
