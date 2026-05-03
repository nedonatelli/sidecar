import { describe, it, expect, vi } from 'vitest';
import { workspace } from 'vscode';
import {
  resolveRoot,
  resolveRootUri,
  getRoot,
  getRootUri,
  validateFilePath,
  isSensitiveFile,
  isProtectedWritePath,
  shellQuote,
  hasShellMetachar,
  formatToolError,
} from './shared.js';

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

// ---------------------------------------------------------------------------
// validateFilePath
// ---------------------------------------------------------------------------
describe('validateFilePath', () => {
  it('returns null for a valid relative path', () => {
    expect(validateFilePath('src/app.ts')).toBeNull();
  });

  it('rejects empty path', () => {
    expect(validateFilePath('')).toContain('empty');
  });

  it('rejects path with backtick', () => {
    expect(validateFilePath('src/`evil`.ts')).toContain('invalid characters');
  });

  it('rejects path longer than 80 chars', () => {
    const long = 'a'.repeat(81);
    expect(validateFilePath(long)).toContain('too long');
  });

  it('rejects path segment longer than 60 chars', () => {
    const longSeg = 'src/' + 'a'.repeat(61) + '.ts';
    expect(validateFilePath(longSeg)).toContain('segment too long');
  });

  it('rejects path traversal', () => {
    expect(validateFilePath('src/../etc/passwd')).toContain('path traversal');
  });

  it('rejects absolute paths', () => {
    expect(validateFilePath('/etc/passwd')).toContain('absolute');
  });
});

// ---------------------------------------------------------------------------
// isSensitiveFile
// ---------------------------------------------------------------------------
describe('isSensitiveFile', () => {
  it('detects .env file', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('.env.local')).toBe(true);
  });

  it('detects .pem, .key, .p12 files', () => {
    expect(isSensitiveFile('server.pem')).toBe(true);
    expect(isSensitiveFile('private.key')).toBe(true);
    expect(isSensitiveFile('cert.p12')).toBe(true);
  });

  it('detects credentials.json', () => {
    expect(isSensitiveFile('credentials.json')).toBe(true);
  });

  it('returns false for normal files', () => {
    expect(isSensitiveFile('app.ts')).toBe(false);
    expect(isSensitiveFile('README.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isProtectedWritePath
// ---------------------------------------------------------------------------
describe('isProtectedWritePath', () => {
  it('blocks .sidecar/settings.json', () => {
    expect(isProtectedWritePath('.sidecar/settings.json')).toContain('settings file');
  });

  it('blocks .sidecar/logs/ paths', () => {
    expect(isProtectedWritePath('.sidecar/logs/api.jsonl')).toContain('audit log');
  });

  it('blocks .sidecar/memory/ paths', () => {
    expect(isProtectedWritePath('.sidecar/memory/facts.md')).toContain('internal state');
  });

  it('allows normal project files', () => {
    expect(isProtectedWritePath('src/app.ts')).toBeNull();
    expect(isProtectedWritePath('.sidecar/SIDECAR.md')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shellQuote / hasShellMetachar / formatToolError
// ---------------------------------------------------------------------------
describe('shellQuote', () => {
  it('wraps in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('hasShellMetachar', () => {
  it('returns true for semicolon', () => {
    expect(hasShellMetachar('cmd; rm -rf /')).toBe(true);
  });

  it('returns true for pipe', () => {
    expect(hasShellMetachar('cmd | cat')).toBe(true);
  });

  it('returns false for normal path', () => {
    expect(hasShellMetachar('src/app.ts')).toBe(false);
  });
});

describe('formatToolError', () => {
  it('extracts message from Error', () => {
    expect(formatToolError(new Error('oops'))).toBe('oops');
  });

  it('stringifies non-Error values', () => {
    expect(formatToolError('raw string')).toBe('raw string');
    expect(formatToolError(42)).toBe('42');
  });
});
