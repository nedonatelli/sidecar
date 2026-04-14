import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch at module level before any imports that use it
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  extractPinReferences,
  resolveUrlReferences,
  getWorkspaceRoot,
  getWorkspaceEnabled,
  getFilePatterns,
  getMaxFiles,
  getContextLimit,
  resolveFileReferences,
  resolveAtReferences,
  matchAllowlistHost,
} from './workspace.js';
import { workspace } from 'vscode';

describe('extractPinReferences', () => {
  it('extracts single pin reference', () => {
    const pins = extractPinReferences('look at @pin:src/config.ts please');
    expect(pins).toEqual(['src/config.ts']);
  });

  it('extracts multiple pin references', () => {
    const pins = extractPinReferences('@pin:src/a.ts and @pin:src/b.ts');
    expect(pins).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns empty array when no pins', () => {
    const pins = extractPinReferences('no pins here');
    expect(pins).toEqual([]);
  });

  it('handles folder pins', () => {
    const pins = extractPinReferences('@pin:src/config/');
    expect(pins).toEqual(['src/config/']);
  });

  it('stops at whitespace', () => {
    const pins = extractPinReferences('@pin:file.ts more text');
    expect(pins).toEqual(['file.ts']);
  });
});

describe('resolveUrlReferences', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('returns text unchanged when no URLs', async () => {
    const result = await resolveUrlReferences('no urls here');
    expect(result).toBe('no urls here');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches URL and appends readable content', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'text/html' : null) },
      text: async () =>
        '<html><body><p>Hello world, this is a documentation page with enough content to pass the minimum length threshold for inclusion in context.</p></body></html>',
    }));

    const result = await resolveUrlReferences('check https://example.com/docs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('Web Page Context');
    expect(result).toContain('https://example.com/docs');
    expect(result).toContain('Hello world');
  });

  it('strips script and style tags', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'text/html' : null) },
      text: async () =>
        '<html><script>alert("xss")</script><style>.x{}</style><p>Clean text with enough content to pass the fifty character minimum threshold for url context.</p></html>',
    }));

    const result = await resolveUrlReferences('see https://example.com');
    expect(result).toContain('Clean text');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('.x{}');
  });

  it('skips non-ok responses', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false }));

    const result = await resolveUrlReferences('check https://example.com/404');
    expect(result).not.toContain('Web Page Context');
  });

  it('skips non-text content types', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'application/pdf' : null) },
    }));

    const result = await resolveUrlReferences('check https://example.com/file.pdf');
    expect(result).not.toContain('Web Page Context');
  });

  it('limits to 3 URLs per message', async () => {
    for (let i = 0; i < 5; i++) {
      fetchMock.mockImplementationOnce(async () => ({
        ok: true,
        headers: { get: (k: string) => (k === 'content-type' ? 'text/plain' : null) },
        text: async () => `Page ${i} with enough content to pass the 50 char minimum threshold`,
      }));
    }

    await resolveUrlReferences('https://a.com https://b.com https://c.com https://d.com https://e.com');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('handles fetch errors gracefully', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('Network error');
    });

    const result = await resolveUrlReferences('check https://unreachable.com');
    expect(result).not.toContain('Web Page Context');
  });

  it('deduplicates repeated URLs', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'text/plain' : null) },
      text: async () => 'content that is long enough to pass the minimum length check for inclusion',
    }));

    await resolveUrlReferences('https://example.com and https://example.com again');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks private/localhost URLs (SSRF protection)', async () => {
    const privateUrls = [
      'https://localhost/secret',
      'https://127.0.0.1/metadata',
      'https://10.0.0.1/internal',
      'https://172.16.0.1/private',
      'https://192.168.1.1/admin',
      'https://169.254.169.254/metadata', // cloud metadata
    ];
    for (const url of privateUrls) {
      fetchMock.mockClear();
      await resolveUrlReferences(`check ${url}`);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// getWorkspaceRoot
// ---------------------------------------------------------------------------
describe('getWorkspaceRoot', () => {
  it('returns the workspace folder path', () => {
    expect(getWorkspaceRoot()).toBe('/mock-workspace');
  });

  it('returns empty string when no workspace folders', () => {
    const orig = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;
    expect(getWorkspaceRoot()).toBe('');
    (workspace as Record<string, unknown>).workspaceFolders = orig;
  });
});

// ---------------------------------------------------------------------------
// getWorkspaceEnabled / getFilePatterns / getMaxFiles / getContextLimit
// ---------------------------------------------------------------------------
describe('workspace config helpers', () => {
  it('getWorkspaceEnabled returns default true', () => {
    expect(getWorkspaceEnabled()).toBe(true);
  });

  it('getFilePatterns returns default patterns array', () => {
    const patterns = getFilePatterns();
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns).toContain('**/*.ts');
    expect(patterns).toContain('**/*.py');
  });

  it('getMaxFiles returns default 10', () => {
    expect(getMaxFiles()).toBe(10);
  });

  it('getContextLimit returns default 0', () => {
    expect(getContextLimit()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveFileReferences
// ---------------------------------------------------------------------------
describe('resolveFileReferences', () => {
  it('returns text unchanged when no file paths found', async () => {
    const result = await resolveFileReferences('just some plain text');
    expect(result).toBe('just some plain text');
  });

  it('appends file content for referenced paths', async () => {
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('file content here') as never);

    const result = await resolveFileReferences('look at ./src/app.ts please');
    expect(result).toContain('Referenced Files');
    expect(result).toContain('src/app.ts');
    expect(result).toContain('file content here');

    vi.restoreAllMocks();
  });

  it('skips files that do not exist', async () => {
    vi.spyOn(workspace.fs, 'stat').mockRejectedValue(new Error('not found'));

    const result = await resolveFileReferences('look at ./nonexistent.ts ');
    expect(result).not.toContain('Referenced Files');

    vi.restoreAllMocks();
  });

  it('deduplicates repeated file references', async () => {
    const statSpy = vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 50 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('content') as never);

    await resolveFileReferences('./src/app.ts and ./src/app.ts again');
    // stat should be called only once due to dedup
    expect(statSpy).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// resolveAtReferences
// ---------------------------------------------------------------------------
describe('resolveAtReferences', () => {
  it('returns text unchanged when no @ references', async () => {
    const result = await resolveAtReferences('no references here');
    expect(result).toBe('no references here');
  });

  it('returns text unchanged when no workspace folders', async () => {
    const orig = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;
    const result = await resolveAtReferences('@file:test.ts');
    expect(result).toBe('@file:test.ts');
    (workspace as Record<string, unknown>).workspaceFolders = orig;
  });
});

describe('matchAllowlistHost', () => {
  it('allows every host when the allowlist is empty (default behavior)', () => {
    expect(matchAllowlistHost('github.com', [])).toBe(true);
    expect(matchAllowlistHost('attacker.xyz', [])).toBe(true);
  });

  it('allows exact hostname matches', () => {
    expect(matchAllowlistHost('github.com', ['github.com'])).toBe(true);
    expect(matchAllowlistHost('api.github.com', ['github.com'])).toBe(false);
  });

  it('allows subdomains under a *.pattern wildcard', () => {
    const list = ['*.github.com'];
    expect(matchAllowlistHost('api.github.com', list)).toBe(true);
    expect(matchAllowlistHost('raw.github.com', list)).toBe(true);
    expect(matchAllowlistHost('github.com', list)).toBe(false); // bare suffix not matched by *.pattern
    expect(matchAllowlistHost('githubhacker.com', list)).toBe(false);
  });

  it('combines bare and wildcard entries for same-origin + subdomains', () => {
    const list = ['github.com', '*.github.com'];
    expect(matchAllowlistHost('github.com', list)).toBe(true);
    expect(matchAllowlistHost('api.github.com', list)).toBe(true);
    expect(matchAllowlistHost('otherhost.com', list)).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    expect(matchAllowlistHost('GitHub.COM', ['github.com'])).toBe(true);
    expect(matchAllowlistHost('API.GitHub.com', ['*.GITHUB.COM'])).toBe(true);
  });

  it('ignores empty / whitespace-only entries', () => {
    expect(matchAllowlistHost('github.com', ['', '   ', 'github.com'])).toBe(true);
    expect(matchAllowlistHost('attacker.xyz', ['', '   '])).toBe(false);
  });
});
