import { describe, it, expect, vi } from 'vitest';
import { workspace } from 'vscode';
import { resolveRoot, resolveRootUri, getRoot, getRootUri } from './shared.js';

describe('resolveRoot / resolveRootUri', () => {
  // The tests exercise the override logic — when a `context.cwd` is
  // present, the helper must prefer it over the workspace folder;
  // without it, both helpers should delegate to the existing
  // getRoot / getRootUri functions. This is the hinge that lets
  // ShadowWorkspace pin every fs.ts tool call into the shadow
  // worktree without changing any tool's internal logic.

  describe('resolveRoot', () => {
    it('returns context.cwd when set', () => {
      expect(resolveRoot({ cwd: '/tmp/shadow-xyz' })).toBe('/tmp/shadow-xyz');
    });

    it('falls back to getRoot() when context is undefined', () => {
      // The vscode mock returns '/mock-workspace' for workspaceFolders[0].
      expect(resolveRoot(undefined)).toBe(getRoot());
    });

    it('falls back to getRoot() when context.cwd is undefined', () => {
      expect(resolveRoot({})).toBe(getRoot());
    });

    it('returns context.cwd even when it is an empty string — treats empty string as explicit', () => {
      // Nullish coalescing (??) on cwd means empty string is kept, not
      // overridden. Documenting the behavior — if someone sets
      // context.cwd to '', they get '' back, not getRoot(). Caller
      // should not pass empty string if they want the workspace
      // fallback; pass undefined instead.
      expect(resolveRoot({ cwd: '' })).toBe('');
    });
  });

  describe('resolveRootUri', () => {
    it('returns a URI built from context.cwd when set', () => {
      const uri = resolveRootUri({ cwd: '/tmp/shadow-xyz' });
      expect(uri.fsPath).toBe('/tmp/shadow-xyz');
    });

    it('falls back to getRootUri() when context is undefined', () => {
      const resolved = resolveRootUri(undefined);
      const direct = getRootUri();
      expect(resolved.fsPath).toBe(direct.fsPath);
    });

    it('throws the workspace-not-open error when no cwd and no workspace folder', () => {
      // Simulate the "fresh VS Code window, no folder open" state.
      // getRootUri throws in this case — resolveRootUri should too
      // when there's nothing to fall back to.
      vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue(undefined as never);
      expect(() => resolveRootUri(undefined)).toThrow(/No workspace folder open/);
      vi.restoreAllMocks();
    });

    it('does NOT throw when no workspace folder but context.cwd is set', () => {
      vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue(undefined as never);
      expect(() => resolveRootUri({ cwd: '/tmp/shadow-xyz' })).not.toThrow();
      vi.restoreAllMocks();
    });
  });
});
