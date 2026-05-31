import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, editFile, readFile } from './fs.js';
import { AuditBuffer, __setDefaultAuditBufferForTests } from '../audit/auditBuffer.js';
import * as settings from '../../config/settings.js';

describe('writeFile audit mode', () => {
  let buf: AuditBuffer;
  let getConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
    getConfigSpy = vi.spyOn(settings, 'getConfig');
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
    getConfigSpy.mockRestore();
  });

  it('buffers write to AuditBuffer when agentMode is audit', async () => {
    getConfigSpy.mockReturnValue({ agentMode: 'audit' } as never);
    const context = { config: { agentMode: 'audit' } as never };
    const result = await writeFile({ path: 'src/app.ts', content: 'const x = 1;' }, context);
    expect(result).toContain('buffered for audit review');
    expect(buf.read('src/app.ts').buffered).toBe(true);
  });

  it('buffers write with correct content', async () => {
    getConfigSpy.mockReturnValue({ agentMode: 'audit' } as never);
    const context = { config: { agentMode: 'audit' } as never };
    await writeFile({ path: 'src/foo.ts', content: 'hello world' }, context);
    const state = buf.read('src/foo.ts');
    expect(state.buffered).toBe(true);
    expect(state.content).toBe('hello world');
  });

  it('does not buffer when agentMode is not audit', async () => {
    getConfigSpy.mockReturnValue({ agentMode: 'autonomous' } as never);
    const context = { config: { agentMode: 'autonomous' } as never };
    // Will try to do a real write, but we don't care — we just verify the buffer is empty
    await writeFile({ path: 'src/x.ts', content: 'data' }, context).catch(() => {});
    expect(buf.read('src/x.ts').buffered).toBe(false);
  });
});

describe('editFile audit mode', () => {
  let buf: AuditBuffer;
  let getConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
    getConfigSpy = vi.spyOn(settings, 'getConfig');
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
    getConfigSpy.mockRestore();
  });

  it('edits buffered content in AuditBuffer when agentMode is audit', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    // First write a file to the buffer
    await buf.write('src/edit.ts', 'const old = 1;\nconst keep = 2;', async () => undefined);
    // Then edit it
    const result = await editFile(
      { path: 'src/edit.ts', search: 'const old = 1;', replace: 'const new_ = 99;' },
      context,
    );
    expect(result).toContain('buffered for audit review');
    const state = buf.read('src/edit.ts');
    expect(state.content).toContain('const new_ = 99;');
  });

  it('returns error when search text not found in buffered content', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/edit2.ts', 'const keep = 1;', async () => undefined);
    const result = await editFile({ path: 'src/edit2.ts', search: 'NOT_IN_FILE', replace: 'replacement' }, context);
    expect(result).toContain('edit_file failed');
  });

  it('returns error when search and replace are identical (no-op guard)', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/noop.ts', 'const x = 1;', async () => undefined);
    const result = await editFile({ path: 'src/noop.ts', search: 'const x = 1;', replace: 'const x = 1;' }, context);
    expect(result).toContain('identical');
    // File must be unchanged
    const state = buf.read('src/noop.ts');
    expect(state.content).toBe('const x = 1;');
  });

  it('appends partial-replace warning when replace is a short substring of search', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    // Simulate the gemma4 pattern: search = full function signature,
    // replace = just the return type keyword (which appears inside search).
    // search: "export function getAnswer(): string {" (38 chars)
    // replace: "string" (6 chars) — IS a substring of search → warning fires
    const fullSig = 'export function getAnswer(): string {';
    await buf.write('src/partial.ts', `${fullSig}\n  return 42;\n}\n`, async () => undefined);
    const result = await editFile({ path: 'src/partial.ts', search: fullSig, replace: 'string' }, context);
    expect(result).toContain('File edited');
    expect(result).toContain('Warning');
    expect(result).toContain('substring');
  });

  it('reads from disk via workspace when file is not in buffer', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from('disk content here') as never);
    const result = await editFile(
      { path: 'src/fresh.ts', search: 'disk content', replace: 'replaced content' },
      context,
    );
    expect(result).toContain('buffered for audit review');
    vi.restoreAllMocks();
  });

  it('returns error when disk file is missing and not buffered', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    const result = await editFile({ path: 'src/missing.ts', search: 'something', replace: 'other' }, context);
    expect(result).toContain('Error: File not found');
    vi.restoreAllMocks();
  });

  it('returns error for deleted buffered file', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    // Write then delete to mark as deleted in buffer
    await buf.write('src/deleted.ts', 'original content', async () => undefined);
    await buf.deleteFile('src/deleted.ts', async () => 'original content');
    const result = await editFile({ path: 'src/deleted.ts', search: 'anything', replace: 'other' }, context);
    expect(result).toContain('Error');
    expect(result).toContain('deleted');
  });
});

describe('readFile audit mode', () => {
  let buf: AuditBuffer;
  let getConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
    getConfigSpy = vi.spyOn(settings, 'getConfig');
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
    getConfigSpy.mockRestore();
  });

  it('reads buffered content when audit mode is active', async () => {
    const context = { config: { agentMode: 'audit' } as never };
    await buf.write('src/buffered.ts', 'buffered content', async () => undefined);
    const result = await readFile({ path: 'src/buffered.ts' }, context);
    expect(result).toContain('buffered content');
  });
});

// ---------------------------------------------------------------------------
// isSensitiveFile guard — write_file, edit_file, read_file must all block
// sensitive paths before they touch the filesystem or audit buffer.
// ---------------------------------------------------------------------------
describe('isSensitiveFile guard', () => {
  const sensitiveNames = [
    '.env',
    '.env.local',
    '.env.production',
    'credentials.json',
    'secrets.json',
    'secrets.yaml',
    'secrets.yml',
    'secret.toml',
    'token.json',
    'service.account.json',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    'private.key',
    'cert.pem',
    'client.p12',
    'bundle.pfx',
  ];

  const safeName = 'src/app.ts';

  describe('writeFile rejects sensitive paths', () => {
    for (const name of sensitiveNames) {
      it(`blocks write to ${name}`, async () => {
        const result = await writeFile({ path: name, content: 'data' });
        expect(result).toMatch(/Error.*secrets or credentials.*not permitted to write/i);
      });
    }

    it('allows write to a non-sensitive file', async () => {
      const { workspace } = await import('vscode');
      vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);
      vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValueOnce(undefined as never);
      const result = await writeFile({ path: safeName, content: 'export {}' });
      expect(result).toContain('File written');
      vi.restoreAllMocks();
    });
  });

  describe('editFile rejects sensitive paths', () => {
    for (const name of sensitiveNames) {
      it(`blocks edit of ${name}`, async () => {
        const result = await editFile({ path: name, search: 'x', replace: 'y' });
        expect(result).toMatch(/Error.*secrets or credentials.*not permitted to edit/i);
      });
    }
  });

  describe('readFile warns on sensitive paths', () => {
    for (const name of sensitiveNames) {
      it(`warns when reading ${name}`, async () => {
        const result = await readFile({ path: name });
        // read issues a Warning (not an Error) to avoid hard-blocking
        expect(result).toMatch(/Warning.*secrets or credentials/i);
      });
    }
  });
});

describe('readFile — file-not-found suggestions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns suggestions when a same-named file exists elsewhere in the workspace', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'FileNotFound' }),
    );
    // findFiles finds the real file at a different path; asRelativePath uses the mock default
    vi.spyOn(workspace, 'findFiles').mockResolvedValueOnce([{ fsPath: '/mock-workspace/src/agent/loop.ts' } as never]);

    const result = await readFile({ path: 'src/agent/loop/runAgentLoop.ts' });
    expect(result).toContain('File not found');
    expect(result).toContain('Did you mean');
    expect(result).toContain('src/agent/loop.ts');
  });

  it('returns a list_directory hint when no similarly-named file exists', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), { code: 'FileNotFound' }),
    );
    vi.spyOn(workspace, 'findFiles').mockResolvedValueOnce([]);

    const result = await readFile({ path: 'src/nonexistent/ghost.ts' });
    expect(result).toContain('File not found');
    expect(result).toContain('ghost.ts');
    expect(result).toContain('list_directory');
    expect(result).not.toContain('Did you mean');
  });

  it('re-throws non-ENOENT errors unchanged', async () => {
    const { workspace } = await import('vscode');
    const permError = Object.assign(new Error('Permission denied'), { code: 'NoPermissions' });
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(permError);

    await expect(readFile({ path: 'src/locked.ts' })).rejects.toThrow('Permission denied');
  });
});

describe('streaming diff via onOutput', () => {
  const DIFF_PREFIX = '\x00diff\x00';

  it('editFile emits a unified diff via onOutput when content changes', async () => {
    const { workspace } = await import('vscode');
    const oldContent = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from(oldContent) as never);
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);

    const chunks: string[] = [];
    const context = { onOutput: (c: string) => chunks.push(c) };
    const result = await editFile({ path: 'src/foo.ts', search: 'const y = 2;', replace: 'const y = 99;' }, context);

    expect(result).toBe('File edited: src/foo.ts');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/^\x00diff\x00/);
    const patch = chunks[0].slice(DIFF_PREFIX.length);
    expect(patch).toContain('--- a/src/foo.ts');
    expect(patch).toContain('+++ b/src/foo.ts');
    expect(patch).toContain('-const y = 2;');
    expect(patch).toContain('+const y = 99;');
    vi.restoreAllMocks();
  });

  it('editFile emits no diff when search === replace (error path, no write)', async () => {
    const chunks: string[] = [];
    const context = { onOutput: (c: string) => chunks.push(c) };
    const result = await editFile({ path: 'src/foo.ts', search: 'same', replace: 'same' }, context);
    expect(result).toContain('Error');
    expect(chunks).toHaveLength(0);
  });

  it('writeFile emits diff via onOutput when file already exists', async () => {
    const { workspace } = await import('vscode');
    const original = 'line A\nline B\nline C\n';
    const newContent = 'line A\nline B modified\nline C\n';
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from(original) as never);
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValueOnce(undefined as never);

    const chunks: string[] = [];
    const context = { onOutput: (c: string) => chunks.push(c) };
    const result = await writeFile({ path: 'src/bar.ts', content: newContent }, context);

    expect(result).toBe('File written: src/bar.ts');
    expect(chunks).toHaveLength(1);
    const patch = chunks[0].slice(DIFF_PREFIX.length);
    expect(patch).toContain('-line B');
    expect(patch).toContain('+line B modified');
    vi.restoreAllMocks();
  });

  it('writeFile emits all-additions diff when file is new', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValueOnce(undefined as never);

    const chunks: string[] = [];
    const context = { onOutput: (c: string) => chunks.push(c) };
    await writeFile({ path: 'src/new.ts', content: 'export const x = 1;\n' }, context);

    expect(chunks).toHaveLength(1);
    const patch = chunks[0].slice(DIFF_PREFIX.length);
    expect(patch).toContain('+export const x = 1;');
    vi.restoreAllMocks();
  });

  it('editFile emits no diff output when onOutput is absent', async () => {
    const { workspace } = await import('vscode');
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValueOnce(Buffer.from('old') as never);
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValueOnce(undefined as never);
    // No onOutput in context — should not throw
    const result = await editFile({ path: 'src/x.ts', search: 'old', replace: 'new' }, {});
    expect(result).toBe('File edited: src/x.ts');
    vi.restoreAllMocks();
  });
});
