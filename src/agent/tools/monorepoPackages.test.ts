import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';
import { monorepoPackagesTool } from './monorepoPackages.js';
import type { MonorepoInfo } from '../../config/monorepoDetector.js';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/repo' } }],
  },
}));

vi.mock('../../config/monorepoDetector.js', () => ({
  detectMonorepo: vi.fn(),
}));

import { detectMonorepo } from '../../config/monorepoDetector.js';

const mockDetect = vi.mocked(detectMonorepo);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('monorepo_packages tool', () => {
  it('returns a formatted table for a detected pnpm workspace', async () => {
    const info: MonorepoInfo = {
      type: 'pnpm',
      packages: [
        { name: '@company/auth', relativePath: 'packages/auth', absolutePath: '/repo/packages/auth' },
        { name: '@company/ui', relativePath: 'packages/ui', absolutePath: '/repo/packages/ui' },
      ],
    };
    mockDetect.mockResolvedValue(info);

    const result = await monorepoPackagesTool.executor({}, undefined as never);

    expect(result).toContain('pnpm');
    expect(result).toContain('@company/auth');
    expect(result).toContain('packages/auth');
    expect(result).toContain('@company/ui');
    expect(result).toContain('packages/ui');
  });

  it('includes a pathPrefix tip in the output', async () => {
    mockDetect.mockResolvedValue({
      type: 'nx',
      packages: [{ name: 'app', relativePath: 'apps/app', absolutePath: '/repo/apps/app' }],
    });

    const result = await monorepoPackagesTool.executor({}, undefined as never);

    expect(result).toContain('pathPrefix');
    expect(result).toContain('project_knowledge_search');
  });

  it('returns a not-detected message when type=none and packages=[]', async () => {
    mockDetect.mockResolvedValue({ type: 'none', packages: [] });

    const result = await monorepoPackagesTool.executor({}, undefined as never);

    expect(result).toContain('No monorepo layout detected');
    expect(result).not.toContain('|'); // no table
  });

  it('returns a "no packages found" message for a recognised type with no packages', async () => {
    mockDetect.mockResolvedValue({ type: 'turbo', packages: [] });

    const result = await monorepoPackagesTool.executor({}, undefined as never);

    expect(result).toContain('turbo');
    expect(result).toContain('no packages found');
  });

  it('returns an error when no workspace folder is open', async () => {
    const orig = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const result = await monorepoPackagesTool.executor({}, undefined as never);
    expect(result).toContain('No workspace folder');

    (workspace as Record<string, unknown>).workspaceFolders = orig;
  });

  it('tool definition has correct name and non-empty description', () => {
    expect(monorepoPackagesTool.definition.name).toBe('monorepo_packages');
    expect(monorepoPackagesTool.definition.description.length).toBeGreaterThan(10);
    expect(monorepoPackagesTool.definition.input_schema.type).toBe('object');
  });

  it('shows package count in output header', async () => {
    mockDetect.mockResolvedValue({
      type: 'yarn',
      packages: [
        { name: 'a', relativePath: 'packages/a', absolutePath: '/repo/packages/a' },
        { name: 'b', relativePath: 'packages/b', absolutePath: '/repo/packages/b' },
        { name: 'c', relativePath: 'packages/c', absolutePath: '/repo/packages/c' },
      ],
    });

    const result = await monorepoPackagesTool.executor({}, undefined as never);
    expect(result).toContain('3');
  });
});
