import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn(() => false) };
});

import { buildBuiltInGuard, resolveGuardsByIds, isBuiltInGuardId, BUILT_IN_GUARD_IDS } from './builtInGuards.js';

const existsSyncMock = vi.mocked(fs.existsSync);

const ROOT = '/workspace';

describe('isBuiltInGuardId', () => {
  it('recognizes known ids', () => {
    for (const id of BUILT_IN_GUARD_IDS) expect(isBuiltInGuardId(id)).toBe(true);
  });
  it('rejects unknown ids', () => {
    expect(isBuiltInGuardId('my-custom-guard')).toBe(false);
    expect(isBuiltInGuardId('')).toBe(false);
  });
});

describe('buildBuiltInGuard', () => {
  beforeEach(() => existsSyncMock.mockReturnValue(false));
  afterEach(() => vi.restoreAllMocks());

  describe('tests-pass', () => {
    it('returns npm test for node ecosystem', () => {
      existsSyncMock.mockImplementation((p) => String(p).endsWith('package.json'));
      const g = buildBuiltInGuard('tests-pass', ROOT);
      expect(g).not.toBeNull();
      expect(g!.command).toContain('npm test');
      expect(g!.trigger).toBe('pre-completion');
      expect(g!.blocking).toBe(true);
    });

    it('returns pytest for python ecosystem', () => {
      existsSyncMock.mockImplementation((p) => String(p).endsWith('pyproject.toml'));
      const g = buildBuiltInGuard('tests-pass', ROOT);
      expect(g).not.toBeNull();
      expect(g!.command).toContain('pytest');
    });

    it('returns cargo test for rust', () => {
      existsSyncMock.mockImplementation((p) => String(p).endsWith('Cargo.toml'));
      const g = buildBuiltInGuard('tests-pass', ROOT);
      expect(g).not.toBeNull();
      expect(g!.command).toContain('cargo test');
    });

    it('returns go test for go', () => {
      existsSyncMock.mockImplementation((p) => String(p).endsWith('go.mod'));
      const g = buildBuiltInGuard('tests-pass', ROOT);
      expect(g).not.toBeNull();
      expect(g!.command).toContain('go test');
    });

    it('returns null when no ecosystem detected', () => {
      const g = buildBuiltInGuard('tests-pass', ROOT);
      expect(g).toBeNull();
    });
  });

  describe('lint-clean', () => {
    it('returns eslint for node', () => {
      existsSyncMock.mockImplementation((p) => String(p).endsWith('package.json'));
      const g = buildBuiltInGuard('lint-clean', ROOT);
      expect(g).not.toBeNull();
      expect(g!.command).toContain('eslint');
      expect(g!.trigger).toBe('post-write');
    });

    it('returns null when no ecosystem detected', () => {
      const g = buildBuiltInGuard('lint-clean', ROOT);
      expect(g).toBeNull();
    });
  });

  describe('no-new-todos', () => {
    it('always returns a guard (no ecosystem needed)', () => {
      const g = buildBuiltInGuard('no-new-todos', ROOT);
      expect(g).not.toBeNull();
      expect(g!.trigger).toBe('pre-completion');
      expect(g!.command).toContain('git diff');
      expect(g!.command).toContain('TODO');
      // Command must exit 0 when no TODOs (test -z semantics)
      expect(g!.command).toContain('test -z');
    });
  });
});

describe('resolveGuardsByIds', () => {
  beforeEach(() => existsSyncMock.mockImplementation((p) => String(p).endsWith('package.json')));
  afterEach(() => vi.restoreAllMocks());

  it('resolves known built-in ids', () => {
    const guards = resolveGuardsByIds(['tests-pass', 'lint-clean'], ROOT);
    expect(guards).toHaveLength(2);
    expect(guards.map((g) => g.name)).toEqual(['tests-pass', 'lint-clean']);
  });

  it('silently skips unknown ids', () => {
    const guards = resolveGuardsByIds(['tests-pass', 'my-unknown-guard'], ROOT);
    expect(guards).toHaveLength(1);
    expect(guards[0].name).toBe('tests-pass');
  });

  it('skips built-in ids that cannot resolve an ecosystem command', () => {
    existsSyncMock.mockReturnValue(false);
    // tests-pass and lint-clean need an ecosystem; no-new-todos doesn't
    const guards = resolveGuardsByIds(['tests-pass', 'lint-clean', 'no-new-todos'], ROOT);
    expect(guards).toHaveLength(1);
    expect(guards[0].name).toBe('no-new-todos');
  });

  it('returns empty array for empty input', () => {
    expect(resolveGuardsByIds([], ROOT)).toHaveLength(0);
  });
});
