import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { ShadowWorkspace } from './shadowWorkspace.js';

// These tests exercise real git operations against a real tmp repo.
// No way to mock git worktree semantics faithfully — the subtle
// behaviors (shared object DB, HEAD detachment, untracked-file diffs)
// only behave right with the real binary. The tmp-repo setup is cheap:
// `git init` + one commit takes ~50ms.
//
// Each test gets its own tmp repo + cleans up after itself so tests
// can run in parallel without stepping on each other's worktrees.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-shadow-test-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  // Disable gpg signing in case the host has commit.gpgsign=true globally —
  // would otherwise hang or fail depending on the signing config.
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // One initial commit so HEAD resolves.
  fs.writeFileSync(path.join(dir, 'README.md'), 'initial\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function rmTmp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — a pending worktree lockfile might hold us up briefly.
  }
}

describe('ShadowWorkspace', () => {
  let mainRoot: string;

  beforeEach(() => {
    mainRoot = makeTmpRepo();
  });

  afterEach(() => {
    rmTmp(mainRoot);
  });

  describe('lifecycle', () => {
    it('creates a worktree at .sidecar/shadows/<id>/ and lists in git worktree list', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      await shadow.create();

      expect(fs.existsSync(shadow.path)).toBe(true);
      expect(shadow.path).toContain(path.join('.sidecar', 'shadows'));
      expect(shadow.isActive).toBe(true);

      const worktrees = git(mainRoot, ['worktree', 'list', '--porcelain']);
      expect(worktrees).toContain(shadow.path);

      await shadow.dispose();
    });

    it('generates unique IDs for concurrent shadows on the same repo', async () => {
      const a = new ShadowWorkspace({ mainRoot });
      const b = new ShadowWorkspace({ mainRoot });
      expect(a.id).not.toBe(b.id);
      // Don't create both — one test's cleanup runs at a time and we
      // don't need full concurrency here, just ID uniqueness.
    });

    it('disposes cleanly — removes worktree and directory', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      await shadow.create();
      expect(fs.existsSync(shadow.path)).toBe(true);

      await shadow.dispose();
      expect(fs.existsSync(shadow.path)).toBe(false);
      expect(shadow.isActive).toBe(false);
    });

    it('dispose is idempotent', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      await shadow.create();
      await shadow.dispose();
      await expect(shadow.dispose()).resolves.toBeUndefined();
    });

    it('throws when diff() is called before create()', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      await expect(shadow.diff()).rejects.toThrow(/create\(\) before/);
    });

    it('throws when diff() is called after dispose()', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      await shadow.create();
      await shadow.dispose();
      await expect(shadow.diff()).rejects.toThrow(/already disposed/);
    });
  });

  describe('diff', () => {
    it('returns empty string when shadow has no changes', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      try {
        await shadow.create();
        const diff = await shadow.diff();
        expect(diff).toBe('');
      } finally {
        await shadow.dispose();
      }
    });

    it('captures tracked-file edits', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      try {
        await shadow.create();
        fs.writeFileSync(path.join(shadow.path, 'README.md'), 'initial\nedited in shadow\n');
        const diff = await shadow.diff();
        expect(diff).toContain('README.md');
        expect(diff).toContain('+edited in shadow');
      } finally {
        await shadow.dispose();
      }
    });

    it('captures untracked (newly created) files', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      try {
        await shadow.create();
        fs.writeFileSync(path.join(shadow.path, 'new-file.ts'), 'export const x = 1;\n');
        const diff = await shadow.diff();
        expect(diff).toContain('new-file.ts');
        expect(diff).toContain('+export const x = 1;');
      } finally {
        await shadow.dispose();
      }
    });
  });

  describe('applyToMain', () => {
    it('returns "No changes" when shadow is clean', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      try {
        await shadow.create();
        const result = await shadow.applyToMain();
        expect(result).toBe('No changes to apply.');
      } finally {
        await shadow.dispose();
      }
    });

    it('applies shadow edits to main as staged changes', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      try {
        await shadow.create();
        fs.writeFileSync(path.join(shadow.path, 'README.md'), 'initial\nfrom shadow\n');
        fs.writeFileSync(path.join(shadow.path, 'new.txt'), 'created in shadow\n');

        await shadow.applyToMain();

        // Main tree reflects the changes.
        const mainReadme = fs.readFileSync(path.join(mainRoot, 'README.md'), 'utf-8');
        expect(mainReadme).toContain('from shadow');
        const mainNew = fs.readFileSync(path.join(mainRoot, 'new.txt'), 'utf-8');
        expect(mainNew).toContain('created in shadow');

        // And they're staged (git status --short starts with capital letter
        // for staged changes). "M " for modified-staged, "A " for added-staged.
        const status = git(mainRoot, ['status', '--short']);
        expect(status).toMatch(/M\s+README\.md/);
        expect(status).toMatch(/A\s+new\.txt/);
      } finally {
        await shadow.dispose();
      }
    });

    it('throws when the patch does not apply cleanly against main', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      try {
        await shadow.create();
        // Edit the same file in BOTH shadow and main, with conflicting
        // content. Shadow's patch will target the original "initial\n"
        // but main now has different content — apply --check fails.
        fs.writeFileSync(path.join(shadow.path, 'README.md'), 'initial\nfrom shadow\n');
        fs.writeFileSync(path.join(mainRoot, 'README.md'), 'initial\nfrom main\n');

        await expect(shadow.applyToMain()).rejects.toThrow();
      } finally {
        await shadow.dispose();
      }
    });
  });

  describe('isolation', () => {
    it('writes to the shadow do not appear in the main tree', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      try {
        await shadow.create();
        fs.writeFileSync(path.join(shadow.path, 'shadow-only.ts'), 'x\n');
        fs.writeFileSync(path.join(shadow.path, 'README.md'), 'shadow edit\n');

        // Main tree is untouched until applyToMain() is called.
        expect(fs.existsSync(path.join(mainRoot, 'shadow-only.ts'))).toBe(false);
        const mainReadme = fs.readFileSync(path.join(mainRoot, 'README.md'), 'utf-8');
        expect(mainReadme).toBe('initial\n');
      } finally {
        await shadow.dispose();
      }
    });

    it('main working-tree edits made while shadow is active stay in main', async () => {
      const shadow = new ShadowWorkspace({ mainRoot });
      try {
        await shadow.create();
        // User continues working in main — this is the realistic concurrent
        // scenario the shadow design is supposed to tolerate for non-
        // overlapping files.
        fs.writeFileSync(path.join(mainRoot, 'user-work.ts'), 'user edit\n');

        // Shadow's diff should NOT include the user's main-tree edit.
        const diff = await shadow.diff();
        expect(diff).not.toContain('user-work.ts');
      } finally {
        await shadow.dispose();
      }
    });
  });
});
