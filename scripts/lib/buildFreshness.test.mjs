import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { staleness, newestMtime, findStaleArtifacts, assertFreshBuild } from './buildFreshness.mjs';

// The guard that stops the integration suite running against a build that does
// not contain the source under test. It fires only on a workstation mid-mistake,
// so without these it would be shipped unobserved — and a stale build passes
// exactly like a fresh one, which is the property that let a dogfood run report
// five passing tests for code that was not in the build.

const t = (sec) => new Date(sec * 1000);

describe('staleness', () => {
  const base = {
    name: 'out/',
    newestSourceMtime: 5_000,
    newestSourceFile: 'src/agent/loop.ts',
    builtBy: 'npm run compile',
  };

  it('passes an artifact newer than every source', () => {
    expect(staleness({ ...base, artifactMtime: 6_000 })).toBeNull();
  });

  it('passes an artifact written in the same millisecond as the newest source', () => {
    // A build reads then writes, so equal mtimes mean the build saw the edit.
    // Treating equality as stale would fail every fast incremental build.
    expect(staleness({ ...base, artifactMtime: 5_000 })).toBeNull();
  });

  it('reports an artifact older than the newest source', () => {
    const p = staleness({ ...base, artifactMtime: 4_000 });
    expect(p).toContain('out/');
    expect(p).toContain('src/agent/loop.ts');
    expect(p).toContain('npm run compile');
  });

  it('reports a missing artifact distinctly from a stale one', () => {
    // Absent and out-of-date need different fixes to be obvious at a glance.
    expect(staleness({ ...base, artifactMtime: 0 })).toContain('missing entirely');
  });

  it('names the command that rebuilds the artifact it is complaining about', () => {
    // out/ and dist/extension.js are built by different commands, and pointing
    // at the wrong one is how someone "fixes" a stale dist by rebuilding out/.
    const p = staleness({
      ...base,
      name: 'dist/extension.js',
      artifactMtime: 1_000,
      builtBy: 'npm run bundle',
    });
    expect(p).toContain('npm run bundle');
    expect(p).not.toContain('npm run compile');
  });

  it('renders a small gap in seconds and a large one in minutes', () => {
    // mtimes are milliseconds. A build minutes behind its source is the case
    // worth reading at a glance, so the units have to switch.
    const src = 3_600_000;
    expect(staleness({ ...base, newestSourceMtime: src, artifactMtime: src - 30_000 })).toContain('30s');
    expect(staleness({ ...base, newestSourceMtime: src, artifactMtime: src - 50 * 60_000 })).toContain('50m');
  });
});

describe('newestMtime', () => {
  it('returns 0 for a directory that does not exist', async () => {
    expect(await newestMtime('/definitely/not/here', () => true)).toBe(0);
  });
});

describe('findStaleArtifacts', () => {
  const build = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'freshness-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'out', 'src'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(root, 'out', 'src', 'a.js'), 'exports.a = 1;\n');
    await writeFile(path.join(root, 'dist', 'extension.js'), '// bundle\n');
    return root;
  };
  const age = async (p, sec) => utimes(p, t(sec), t(sec));

  it('is silent when both artifacts are newer than the source', async () => {
    const root = await build();
    try {
      await age(path.join(root, 'src', 'a.ts'), 1_000);
      await age(path.join(root, 'out', 'src', 'a.js'), 2_000);
      await age(path.join(root, 'dist', 'extension.js'), 2_000);
      expect(await findStaleArtifacts(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('catches a stale out/src/ while dist/ is current', async () => {
    // Reachable via `npx vscode-test`, which skips the npm script and so skips
    // the integration compile. The two artifacts have to be judged separately —
    // a current dist/ says nothing about the code the tests require().
    const root = await build();
    try {
      await age(path.join(root, 'out', 'src', 'a.js'), 1_000);
      await age(path.join(root, 'src', 'a.ts'), 2_000);
      await age(path.join(root, 'dist', 'extension.js'), 3_000);
      const problems = await findStaleArtifacts(root);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('out/src/');
      expect(problems[0]).toContain('src/a.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('catches a stale dist/ while out/ is current', async () => {
    const root = await build();
    try {
      await age(path.join(root, 'dist', 'extension.js'), 1_000);
      await age(path.join(root, 'src', 'a.ts'), 2_000);
      await age(path.join(root, 'out', 'src', 'a.js'), 3_000);
      const problems = await findStaleArtifacts(root);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('dist/extension.js');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports both artifacts when both are behind', async () => {
    const root = await build();
    try {
      await age(path.join(root, 'out', 'src', 'a.js'), 1_000);
      await age(path.join(root, 'dist', 'extension.js'), 1_000);
      await age(path.join(root, 'src', 'a.ts'), 2_000);
      expect(await findStaleArtifacts(root)).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores .d.ts files when deciding what the newest source is', async () => {
    // Generated declarations are build output; treating one as a source would
    // make every build permanently stale against its own product.
    const root = await build();
    try {
      await age(path.join(root, 'src', 'a.ts'), 1_000);
      await age(path.join(root, 'out', 'src', 'a.js'), 2_000);
      await age(path.join(root, 'dist', 'extension.js'), 2_000);
      const decl = path.join(root, 'src', 'a.d.ts');
      await writeFile(decl, 'export declare const a: number;\n');
      await age(decl, 9_000);
      expect(await findStaleArtifacts(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not walk into out/ when looking for sources', async () => {
    // out/ holds copies of the .ts tree in some layouts. Counting those as
    // sources would compare the build against itself and never fire.
    const root = await build();
    try {
      await age(path.join(root, 'src', 'a.ts'), 1_000);
      await age(path.join(root, 'out', 'src', 'a.js'), 2_000);
      await age(path.join(root, 'dist', 'extension.js'), 2_000);
      const copied = path.join(root, 'out', 'src', 'copy.ts');
      await writeFile(copied, 'export const a = 1;\n');
      await age(copied, 9_000);
      expect(await findStaleArtifacts(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('assertFreshBuild', () => {
  it('throws naming every stale artifact and how to fix it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'freshness-throw-'));
    try {
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      await expect(assertFreshBuild(root)).rejects.toThrow(/missing entirely/);
      // Each artifact must name its own builder: out/src/ comes from the
      // integration tsconfig, dist/extension.js from esbuild. Pointing at the
      // wrong one is how someone "fixes" a stale dist by rebuilding out/.
      await expect(assertFreshBuild(root)).rejects.toThrow(/tsc -p src\/test\/integration/);
      await expect(assertFreshBuild(root)).rejects.toThrow(/npm run bundle/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves silently on a current build', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'freshness-ok-'));
    try {
      await mkdir(path.join(root, 'src'), { recursive: true });
      await mkdir(path.join(root, 'out', 'src'), { recursive: true });
      await mkdir(path.join(root, 'dist'), { recursive: true });
      await writeFile(path.join(root, 'src', 'a.ts'), '');
      await writeFile(path.join(root, 'out', 'src', 'a.js'), '');
      await writeFile(path.join(root, 'dist', 'extension.js'), '');
      await utimes(path.join(root, 'src', 'a.ts'), t(1_000), t(1_000));
      await utimes(path.join(root, 'out', 'src', 'a.js'), t(2_000), t(2_000));
      await utimes(path.join(root, 'dist', 'extension.js'), t(2_000), t(2_000));
      await expect(assertFreshBuild(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
